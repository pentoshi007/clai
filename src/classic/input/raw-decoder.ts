import type { DecodedEvent, KeyEvent, KeyModifiers } from "./key-event.js";
import { keyEvent } from "./key-event.js";
import { sanitizePasteText } from "./paste-decoder.js";
import { parseSgrMouse } from "./sgr-mouse.js";
import {
  BEL,
  CSI_FINAL_KEYS,
  CSI_TILDE_KEYS,
  CSI_U_KEYS,
  CTRL_LETTER_EXCEPTIONS,
  CTRL_SYMBOLS,
  ESC,
  ESCAPE_TIMEOUT_MS,
  PASTE_END,
  PASTE_MAX_BYTES,
  PASTE_TIMEOUT_MS,
  SS3_KEYS,
  isCsiFinalByte,
  isCsiParameterByte,
  modifiersFromCsi,
} from "./terminal-sequences.js";

export interface RawDecoderOptions {
  readonly now?: (() => number) | undefined;
  readonly mouse?: boolean | undefined;
  readonly onWarn?: ((message: string) => void) | undefined;
}

const STRING_SEQUENCE_STARTERS = new Set(["]", "P", "_", "^", "X"]);

const graphemeSegmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : undefined;

function graphemes(text: string): string[] {
  if (!graphemeSegmenter) return [...text];
  return [...graphemeSegmenter.segment(text)].map((s) => s.segment);
}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

function controlKey(char: string): KeyEvent {
  const code = char.charCodeAt(0);
  if (code === 0x7f) return keyEvent("backspace");
  const symbol = CTRL_SYMBOLS[code];
  if (symbol) return keyEvent(symbol, { ctrl: true });
  const exception = CTRL_LETTER_EXCEPTIONS[code];
  if (exception === "tab") return keyEvent("tab", {}, "\t");
  if (exception === "enter") return keyEvent("enter");
  if (exception) return keyEvent(exception, { ctrl: true });
  if (code >= 0x01 && code <= 0x1a) {
    return keyEvent(String.fromCharCode(code + 0x60), { ctrl: true });
  }
  return keyEvent("escape");
}

function altKey(char: string): KeyEvent {
  if (char === "\r") return keyEvent("enter", { alt: true });
  if (char === "\n") return keyEvent("j", { ctrl: true, alt: true });
  if (char === "\t") return keyEvent("tab", { alt: true });
  if (char === "\x7f") return keyEvent("backspace", { alt: true });
  if (isControl(char)) {
    const base = controlKey(char);
    return { ...base, alt: true };
  }
  const lower = char.toLowerCase();
  return keyEvent(lower, { alt: true, shift: lower !== char });
}

function namedKey(name: string, modifiers: KeyModifiers): KeyEvent {
  return keyEvent(name, modifiers);
}

function csiUKey(code: number, modifiers: KeyModifiers): KeyEvent | undefined {
  if (!Number.isInteger(code) || code < 0) return undefined;
  const named = CSI_U_KEYS[code];
  if (named) return keyEvent(named, modifiers);
  let char: string;
  try {
    char = String.fromCodePoint(code);
  } catch {
    return undefined;
  }
  const lower = char.toLowerCase();
  const printable = code >= 32 && code !== 127;
  const bare = !modifiers.ctrl && !modifiers.alt && !modifiers.meta;
  return keyEvent(
    lower,
    { ...modifiers, shift: modifiers.shift === true || lower !== char },
    printable && bare ? char : "",
  );
}

export class RawDecoder {
  private buffer = "";
  private pasting = false;
  private pasteText = "";
  private pasteTouchedAt = 0;
  private escapeSeenAt: number | undefined;
  private readonly now: () => number;
  private readonly mouse: boolean;

  constructor(private readonly options: RawDecoderOptions = {}) {
    this.now = options.now ?? Date.now;
    this.mouse = options.mouse === true;
  }

  get pendingDeadline(): number | undefined {
    if (this.pasting) return this.pasteTouchedAt + PASTE_TIMEOUT_MS;
    if (this.escapeSeenAt !== undefined) return this.escapeSeenAt + ESCAPE_TIMEOUT_MS;
    return undefined;
  }

  get pending(): boolean {
    return this.buffer.length > 0 || this.pasting;
  }

  push(chunk: string): readonly DecodedEvent[] {
    if (chunk.length === 0) return [];
    this.buffer += chunk;
    return this.drain(false);
  }

  flush(): readonly DecodedEvent[] {
    return this.drain(true);
  }

  private drain(final: boolean): readonly DecodedEvent[] {
    const events: DecodedEvent[] = [];
    while (this.buffer.length > 0 || (final && this.pasting)) {
      if (this.pasting) {
        if (!this.consumePaste(events, final)) break;
        continue;
      }
      const char = this.buffer[0] as string;
      if (char !== ESC) {
        this.consumePlain(events, char);
        continue;
      }
      const consumed = this.consumeEscape(events, final);
      if (!consumed) break;
    }
    if (this.pasting) {
      this.escapeSeenAt = undefined;
    } else if (this.buffer.startsWith(ESC)) {
      this.escapeSeenAt ??= this.now();
    } else {
      this.escapeSeenAt = undefined;
    }
    return events;
  }

  private consumePlain(events: DecodedEvent[], char: string): void {
    if (isControl(char)) {
      events.push({ type: "key", key: controlKey(char) });
      this.buffer = this.buffer.slice(1);
      return;
    }
    let end = 1;
    while (end < this.buffer.length) {
      const next = this.buffer[end] as string;
      if (next === ESC || isControl(next)) break;
      end += 1;
    }
    const text = this.buffer.slice(0, end);
    this.buffer = this.buffer.slice(end);
    for (const grapheme of graphemes(text)) {
      const lower = grapheme.toLowerCase();
      events.push({
        type: "key",
        key: keyEvent(lower, { shift: lower !== grapheme }, grapheme),
      });
    }
  }

  private consumePaste(events: DecodedEvent[], final: boolean): boolean {
    const end = this.buffer.indexOf(PASTE_END);
    if (end >= 0) {
      this.pasteText += this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + PASTE_END.length);
      events.push({ type: "paste", text: sanitizePasteText(this.pasteText) });
      this.pasting = false;
      this.pasteText = "";
      return true;
    }
    const keep = partialSuffixLength(this.buffer, PASTE_END);
    this.pasteText += this.buffer.slice(0, this.buffer.length - keep);
    this.buffer = this.buffer.slice(this.buffer.length - keep);
    const now = this.now();
    const overSize = this.pasteText.length > PASTE_MAX_BYTES;
    const overTime = now - this.pasteTouchedAt > PASTE_TIMEOUT_MS;
    if (final || overSize || overTime) {
      events.push({ type: "paste", text: sanitizePasteText(this.pasteText + this.buffer) });
      this.options.onWarn?.(
        overSize
          ? "paste truncated · exceeded the 1 MiB bracketed-paste limit"
          : "paste ended without a terminator",
      );
      this.pasting = false;
      this.pasteText = "";
      this.buffer = "";
      return true;
    }
    this.pasteTouchedAt = now;
    return false;
  }

  private consumeEscape(events: DecodedEvent[], final: boolean): boolean {
    if (this.buffer.length === 1) {
      if (!final) return false;
      this.buffer = "";
      events.push({ type: "key", key: keyEvent("escape") });
      return true;
    }
    const next = this.buffer[1] as string;
    if (next === ESC) return this.consumeDoubleEscape(events, final);
    if (next === "[") return this.consumeCsi(events, final);
    if (next === "O") return this.consumeSs3(events, final);
    if (STRING_SEQUENCE_STARTERS.has(next)) return this.consumeStringSequence(final);
    this.buffer = this.buffer.slice(2);
    events.push({ type: "key", key: altKey(next) });
    return true;
  }

  private consumeDoubleEscape(events: DecodedEvent[], final: boolean): boolean {
    const third = this.buffer[2];
    if (third === undefined) {
      if (!final) return false;
      this.buffer = this.buffer.slice(1);
      events.push({ type: "key", key: keyEvent("escape") });
      return true;
    }
    if (third !== "[" && third !== "O") {
      this.buffer = this.buffer.slice(1);
      events.push({ type: "key", key: keyEvent("escape") });
      return true;
    }
    const restored = this.buffer;
    this.buffer = this.buffer.slice(1);
    const start = events.length;
    const consumed =
      third === "[" ? this.consumeCsi(events, final) : this.consumeSs3(events, final);
    if (!consumed) {
      this.buffer = restored;
      return false;
    }
    for (let index = start; index < events.length; index += 1) {
      const event = events[index];
      if (event?.type === "key") {
        events[index] = { type: "key", key: { ...event.key, alt: true } };
      }
    }
    return true;
  }

  private consumeCsi(events: DecodedEvent[], final: boolean): boolean {
    let index = 2;
    while (index < this.buffer.length && isCsiParameterByte(this.buffer[index] as string)) {
      index += 1;
    }
    if (index >= this.buffer.length) return this.waitOrDrop(final);
    const finalByte = this.buffer[index] as string;
    if (!isCsiFinalByte(finalByte)) {
      this.buffer = this.buffer.slice(index + 1);
      return true;
    }
    const body = this.buffer.slice(2, index);
    this.buffer = this.buffer.slice(index + 1);
    this.dispatchCsi(events, body, finalByte);
    return true;
  }

  private dispatchCsi(events: DecodedEvent[], body: string, finalByte: string): void {
    if (body === "200" && finalByte === "~") {
      this.pasting = true;
      this.pasteText = "";
      this.pasteTouchedAt = this.now();
      return;
    }
    if (body === "201" && finalByte === "~") return;
    if (body.startsWith("<")) {
      const event = parseSgrMouse(body.slice(1), finalByte);
      if (event && this.mouse) events.push({ type: "mouse", event });
      return;
    }
    const params = body.split(";").map((part) => Number(part.split(":")[0]));
    const modifiers = modifiersFromCsi(params[1]);
    if (finalByte === "u") {
      const key = csiUKey(params[0] as number, modifiers);
      if (key) events.push({ type: "key", key });
      return;
    }
    if (finalByte === "~") {
      const name = CSI_TILDE_KEYS[params[0] as number];
      if (name) events.push({ type: "key", key: namedKey(name, modifiers) });
      return;
    }
    if (finalByte === "Z") {
      events.push({ type: "key", key: keyEvent("tab", { ...modifiers, shift: true }) });
      return;
    }
    const name = CSI_FINAL_KEYS[finalByte];
    if (name) events.push({ type: "key", key: namedKey(name, modifiers) });
  }

  private consumeSs3(events: DecodedEvent[], final: boolean): boolean {
    if (this.buffer.length < 3) return this.waitOrDrop(final);
    const name = SS3_KEYS[this.buffer[2] as string];
    this.buffer = this.buffer.slice(3);
    if (name) events.push({ type: "key", key: keyEvent(name) });
    return true;
  }

  private consumeStringSequence(final: boolean): boolean {
    const bel = this.buffer.indexOf(BEL, 2);
    const st = this.buffer.indexOf("\x1b\\", 2);
    const end = bel >= 0 && (st < 0 || bel < st) ? bel + 1 : st >= 0 ? st + 2 : -1;
    if (end < 0) return this.waitOrDrop(final);
    this.buffer = this.buffer.slice(end);
    return true;
  }

  private waitOrDrop(final: boolean): boolean {
    if (!final) return false;
    this.buffer = "";
    return true;
  }
}

function partialSuffixLength(buffer: string, terminator: string): number {
  const max = Math.min(terminator.length - 1, buffer.length);
  for (let length = max; length > 0; length -= 1) {
    if (terminator.startsWith(buffer.slice(buffer.length - length))) return length;
  }
  return 0;
}
