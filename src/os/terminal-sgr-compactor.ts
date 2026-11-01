import { applySgr, sgrDifference, type SgrState } from "./sgr-state.js";

const CURSOR_ONLY = /^\x1b\[[\d;]*[ABCDEFGHf`ade]$/;
const CONTROL_STRING_START = new Set(["]", "P", "_", "^", "X"]);
const MAX_SEQUENCE_LENGTH = 512;

function csiEnd(input: string, start: number): number {
  for (let index = start + 2; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index + 1;
    if (code < 0x20 || code > 0x3f) return index;
  }
  return input.length;
}

export class TerminalSgrCompactor {
  private emitted: SgrState | undefined;
  private desired: SgrState | undefined;
  private pendingStyle = "";
  private pendingEscape = "";
  private controlString: "osc" | "other" | undefined;
  private stringEscape = false;
  private passthroughCsi = false;

  compact(bytes: Uint8Array): Uint8Array {
    const input = this.pendingEscape + Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
    this.pendingEscape = "";
    const output: string[] = [];
    let index = 0;
    while (index < input.length) {
      if (this.controlString) {
        const end = this.consumeString(input, index);
        output.push(input.slice(index, end));
        index = end;
        continue;
      }
      if (this.passthroughCsi) {
        const end = this.consumeCsi(input, index);
        output.push(input.slice(index, end));
        index = end;
        continue;
      }
      const escape = input.indexOf("\x1b", index);
      const end = escape < 0 ? input.length : escape;
      if (end > index) {
        output.push(this.flushStyle(), input.slice(index, end));
        index = end;
      }
      if (escape < 0) break;
      index = this.consumeEscape(input, index, output);
    }
    output.push(this.flushStyle());
    return Buffer.from(output.join(""), "latin1");
  }

  finish(): Uint8Array {
    const bytes = Buffer.from(this.flushStyle() + this.pendingEscape, "latin1");
    this.pendingEscape = "";
    this.controlString = undefined;
    this.stringEscape = false;
    this.passthroughCsi = false;
    this.emitted = undefined;
    this.desired = undefined;
    return bytes;
  }

  private consumeString(input: string, start: number): number {
    for (let index = start; index < input.length; index += 1) {
      const char = input[index];
      if ((this.stringEscape && char === "\\") || (this.controlString === "osc" && char === "\x07")) {
        this.controlString = undefined;
        this.stringEscape = false;
        return index + 1;
      }
      this.stringEscape = char === "\x1b";
    }
    return input.length;
  }

  private consumeCsi(input: string, start: number): number {
    for (let index = start; index < input.length; index += 1) {
      const code = input.charCodeAt(index);
      if (code >= 0x40 && code <= 0x7e) {
        this.passthroughCsi = false;
        return index + 1;
      }
    }
    return input.length;
  }

  private consumeEscape(input: string, start: number, output: string[]): number {
    const kind = input[start + 1];
    if (kind === undefined) {
      this.pendingEscape = input.slice(start);
      return input.length;
    }
    if (CONTROL_STRING_START.has(kind)) {
      output.push(this.flushStyle(), input.slice(start, start + 2));
      this.emitted = undefined;
      this.desired = undefined;
      this.controlString = kind === "]" ? "osc" : "other";
      return start + 2;
    }
    if (kind === "[") return this.consumeSequence(input, start, output);
    let end = start + 1;
    while (end < input.length && input.charCodeAt(end) >= 0x20 && input.charCodeAt(end) <= 0x2f) end += 1;
    if (end === input.length && end - start <= MAX_SEQUENCE_LENGTH) {
      this.pendingEscape = input.slice(start);
      return end;
    }
    output.push(this.flushStyle(), input.slice(start, end + 1));
    this.emitted = undefined;
    this.desired = undefined;
    return end + 1;
  }

  private consumeSequence(input: string, start: number, output: string[]): number {
    const end = csiEnd(input, start);
    const sequence = input.slice(start, end);
    const final = sequence.charCodeAt(sequence.length - 1);
    if (final < 0x40 || final > 0x7e || sequence.length < 3) {
      if (end === input.length && sequence.length <= MAX_SEQUENCE_LENGTH) {
        this.pendingEscape = sequence;
        return end;
      }
      output.push(this.flushStyle(), sequence);
      this.emitted = undefined;
      this.desired = undefined;
      this.passthroughCsi = end === input.length;
      return end;
    }
    if (sequence.endsWith("m")) this.consumeStyle(sequence, output);
    else if (CURSOR_ONLY.test(sequence)) output.push(sequence);
    else {
      output.push(this.flushStyle(), sequence);
      this.emitted = undefined;
      this.desired = undefined;
    }
    return end;
  }

  private consumeStyle(sequence: string, output: string[]): void {
    const next = applySgr(this.desired, sequence.slice(2, -1));
    if (this.emitted === undefined || next === undefined) {
      output.push(this.flushStyle(), sequence);
      this.emitted = next;
    } else {
      this.pendingStyle += sequence;
    }
    this.desired = next;
    if (this.pendingStyle.length > MAX_SEQUENCE_LENGTH) output.push(this.flushStyle());
  }

  private flushStyle(): string {
    const original = this.pendingStyle;
    if (!original) return "";
    this.pendingStyle = "";
    if (this.emitted === undefined || this.desired === undefined) return original;
    const difference = sgrDifference(this.emitted, this.desired);
    this.emitted = this.desired;
    return difference.length < original.length ? difference : original;
  }
}
