/**
 * Bounded streaming redaction over raw child output.
 *
 * Two lanes run before any byte receives a cursor, so raw sensitive data never
 * reaches memory retention, artifacts, telemetry, or presentation:
 *
 *  1. A byte matcher removes the exact UTF-8 encodings of registered sensitive
 *     values across arbitrary chunk splits, including next to invalid UTF-8.
 *  2. A decoder applies the existing textual secret patterns to the valid UTF-8
 *     runs of the emitted region.
 *
 * Retention is bounded: the only bytes held back are an incomplete trailing
 * UTF-8 code point and a tail that is still a viable prefix of a registered
 * secret. Prompts without a trailing newline therefore emit immediately.
 */

import { redactSecrets } from "../llm/provider.js";
import { throwSessionError, type SessionOperation } from "./types.js";

export const REDACTION_MARKER = "[redacted]";
const MARKER_BYTES = new Uint8Array(Buffer.from(REDACTION_MARKER, "utf8"));

export function trailingIncompleteUtf8Bytes(bytes: Uint8Array): number {
  const len = bytes.length;
  for (let back = 1; back <= 3 && back <= len; back += 1) {
    const byte = bytes[len - back]!;
    if ((byte & 0xc0) === 0x80) continue;
    let expected = 1;
    if ((byte & 0xe0) === 0xc0) expected = 2;
    else if ((byte & 0xf0) === 0xe0) expected = 3;
    else if ((byte & 0xf8) === 0xf0) expected = 4;
    return expected > back ? back : 0;
  }
  return 0;
}

export interface Utf8Run {
  readonly valid: boolean;
  readonly bytes: Uint8Array;
}

export function splitUtf8Runs(bytes: Uint8Array): Utf8Run[] {
  const runs: Utf8Run[] = [];
  let index = 0;
  let validStart = 0;
  const pushRun = (valid: boolean, start: number, end: number): void => {
    if (end > start) runs.push({ valid, bytes: bytes.subarray(start, end) });
  };
  while (index < bytes.length) {
    const width = utf8SequenceWidth(bytes, index);
    if (width > 0) {
      index += width;
      continue;
    }
    pushRun(true, validStart, index);
    const invalidStart = index;
    while (index < bytes.length && utf8SequenceWidth(bytes, index) === 0) index += 1;
    pushRun(false, invalidStart, index);
    validStart = index;
  }
  pushRun(true, validStart, index);
  return runs;
}

function utf8SequenceWidth(bytes: Uint8Array, index: number): number {
  const byte = bytes[index]!;
  if (byte < 0x80) return 1;
  let width = 0;
  if ((byte & 0xe0) === 0xc0) width = 2;
  else if ((byte & 0xf0) === 0xe0) width = 3;
  else if ((byte & 0xf8) === 0xf0) width = 4;
  else return 0;
  if (index + width > bytes.length) return 0;
  for (let offset = 1; offset < width; offset += 1) {
    if ((bytes[index + offset]! & 0xc0) !== 0x80) return 0;
  }
  const second = bytes[index + 1]!;
  if (width === 2 && byte < 0xc2) return 0;
  if (width === 3 && byte === 0xe0 && second < 0xa0) return 0;
  if (width === 3 && byte === 0xed && second >= 0xa0) return 0;
  if (width === 4 && (byte > 0xf4 || (byte === 0xf0 && second < 0x90))) return 0;
  if (width === 4 && byte === 0xf4 && second > 0x8f) return 0;
  return width;
}

function indexOfSequence(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  return Buffer.from(
    haystack.buffer,
    haystack.byteOffset,
    haystack.byteLength,
  ).indexOf(Buffer.from(needle), from);
}

/**
 * Literal prefixes of the textual secret patterns applied by `redactSecrets`.
 * They bound how much tail must be retained so a token split across chunks is
 * still matched, without holding back ordinary prompt text.
 */
const TEXT_SECRET_PREFIXES = [
  "gsk_",
  "AIza",
  "AQ.",
  "sk-",
  "nvapi-",
  "wk-",
  "ws-",
] as const;
const TOKEN_BODY_RE = /^[A-Za-z0-9._-]*$/;

export class StreamingSecretRedactor {
  private pending: Uint8Array = new Uint8Array(0);
  private readonly secrets: Uint8Array[] = [];
  private redactedAny = false;
  private closed = false;

  constructor(private readonly overlapBytes: number) {}

  get redacted(): boolean {
    return this.redactedAny;
  }

  registerExactSecret(value: string, operation: SessionOperation = "send"): void {
    if (value.length === 0) return;
    const bytes = new Uint8Array(Buffer.from(value, "utf8"));
    if (bytes.length > this.overlapBytes) {
      throwSessionError({
        code: "INVALID_CONFIGURATION",
        operation,
        message:
          "A sensitive value exceeds the configured redaction match span and cannot be redacted safely.",
        details: { field: "redactionOverlapBytes", limitBytes: this.overlapBytes },
      });
    }
    if (this.secrets.some((existing) => Buffer.from(existing).equals(bytes))) return;
    this.secrets.push(bytes);
  }

  private viablePrefixTail(bytes: Uint8Array): number {
    let longest = 0;
    for (const secret of this.secrets) {
      const max = Math.min(secret.length - 1, bytes.length);
      for (let length = max; length > longest; length -= 1) {
        const tail = bytes.subarray(bytes.length - length);
        if (Buffer.from(tail).equals(Buffer.from(secret.subarray(0, length)))) {
          longest = length;
          break;
        }
      }
    }
    return Math.min(longest, this.overlapBytes);
  }

  private viablePatternTail(bytes: Uint8Array): number {
    const window = bytes.subarray(Math.max(0, bytes.length - this.overlapBytes));
    const text = Buffer.from(window).toString("latin1");
    let longest = 0;
    for (const prefix of TEXT_SECRET_PREFIXES) {
      const start = text.lastIndexOf(prefix);
      if (start >= 0 && TOKEN_BODY_RE.test(text.slice(start + prefix.length))) {
        longest = Math.max(longest, text.length - start);
      }
      for (let length = Math.min(prefix.length - 1, text.length); length > longest; length -= 1) {
        if (text.endsWith(prefix.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return Math.min(longest, this.overlapBytes);
  }

  push(raw: Uint8Array): Uint8Array {
    if (this.closed) throw new Error("Cannot push into a closed redactor");
    this.pending = concat(this.pending, raw);
    const keepIncomplete = trailingIncompleteUtf8Bytes(this.pending);
    const keepSecret = this.viablePrefixTail(this.pending);
    const keepPattern = this.viablePatternTail(this.pending);
    const keep = Math.min(
      Math.max(keepIncomplete, keepSecret, keepPattern),
      Math.min(this.pending.length, this.overlapBytes),
    );
    const emitEnd = this.pending.length - keep;
    if (emitEnd <= 0) return new Uint8Array(0);
    const region = this.pending.subarray(0, emitEnd);
    this.pending = new Uint8Array(this.pending.subarray(emitEnd));
    return this.transform(region);
  }

  close(): Uint8Array {
    if (this.closed) return new Uint8Array(0);
    this.closed = true;
    const region = this.pending;
    this.pending = new Uint8Array(0);
    return region.length > 0 ? this.transform(region) : new Uint8Array(0);
  }

  private transform(region: Uint8Array): Uint8Array {
    const byteLane = this.applyByteLane(region);
    const parts: Uint8Array[] = [];
    for (const run of splitUtf8Runs(byteLane)) {
      if (!run.valid) {
        parts.push(run.bytes);
        continue;
      }
      const text = Buffer.from(run.bytes).toString("utf8");
      const safe = redactSecrets(text);
      if (safe !== text) this.redactedAny = true;
      parts.push(new Uint8Array(Buffer.from(safe, "utf8")));
    }
    return concatAll(parts);
  }

  private applyByteLane(region: Uint8Array): Uint8Array {
    if (this.secrets.length === 0) return region;
    let current = region;
    for (const secret of this.secrets) {
      let cursor = 0;
      const parts: Uint8Array[] = [];
      for (;;) {
        const found = indexOfSequence(current, secret, cursor);
        if (found < 0) break;
        parts.push(current.subarray(cursor, found), MARKER_BYTES);
        cursor = found + secret.length;
        this.redactedAny = true;
      }
      if (parts.length === 0) continue;
      parts.push(current.subarray(cursor));
      current = concatAll(parts);
    }
    return current;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return new Uint8Array(b);
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
