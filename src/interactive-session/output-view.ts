/**
 * Presentation views over canonical redacted output bytes.
 *
 * `encoded` is base64: it round-trips the exact canonical bytes and cannot
 * execute a control sequence anywhere. `plain` is a bounded linearizer, not a
 * terminal emulator: it keeps no screen grid, no alternate screen, and no
 * cursor-addressable replay, and it guarantees that no host-terminal control
 * byte survives into model, transcript, log, or UI output.
 */

import type { OutputEvent, OutputView, PresentedOutputEvent } from "./types.js";

const REPLACEMENT = "\uFFFD";

const PLAIN_TOKENS = {
  backspace: "⌫",
  osc: "[osc]",
  dcs: "[dcs]",
  nul: "^@",
} as const;

interface DecodeResult {
  readonly text: string;
  readonly loss: boolean;
}

function decodeUtf8(bytes: Uint8Array): DecodeResult {
  const text = Buffer.from(bytes).toString("utf8");
  return { text, loss: text.includes(REPLACEMENT) };
}

function controlToken(code: number): string {
  if (code === 0) return PLAIN_TOKENS.nul;
  if (code < 0x20) return `^${String.fromCharCode(code + 64)}`;
  return `^[0x${code.toString(16).padStart(2, "0")}]`;
}

export function neutralizeTerminalControls(input: string): string {
  let out = "";
  let index = 0;
  while (index < input.length) {
    const char = input[index]!;
    const code = char.codePointAt(0)!;

    if (code === 0x1b) {
      const next = input[index + 1];
      if (next === "[") {
        let cursor = index + 2;
        while (cursor < input.length && /[\d;?<>=: ]/.test(input[cursor]!)) cursor += 1;
        if (cursor < input.length) cursor += 1;
        index = cursor;
        continue;
      }
      if (next === "]") {
        index = consumeStringSequence(input, index + 2);
        out += PLAIN_TOKENS.osc;
        continue;
      }
      if (next === "P" || next === "X" || next === "^" || next === "_") {
        index = consumeStringSequence(input, index + 2);
        out += PLAIN_TOKENS.dcs;
        continue;
      }
      index += next === undefined ? 1 : 2;
      continue;
    }

    if (char === "\r") {
      if (input[index + 1] === "\n") {
        out += "\n";
        index += 2;
      } else {
        out += "\n";
        index += 1;
      }
      continue;
    }
    if (char === "\b") {
      out += PLAIN_TOKENS.backspace;
      index += 1;
      continue;
    }
    if (char === "\n" || char === "\t") {
      out += char;
      index += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += controlToken(code);
      index += 1;
      continue;
    }
    out += char;
    index += char.length;
  }
  return out;
}

function consumeStringSequence(input: string, start: number): number {
  let index = start;
  while (index < input.length) {
    const char = input[index]!;
    if (char === "\u0007") return index + 1;
    if (char === "\u001b" && input[index + 1] === "\\") return index + 2;
    if (char === "\u009c") return index + 1;
    index += 1;
  }
  return index;
}

export function presentEvent(
  event: OutputEvent,
  view: OutputView,
): PresentedOutputEvent {
  if (view === "encoded") {
    return {
      startCursor: event.startCursor,
      endCursor: event.endCursor,
      stream: event.stream,
      observedAt: event.observedAt,
      content: Buffer.from(event.bytes).toString("base64"),
    };
  }
  const decoded = decodeUtf8(event.bytes);
  return {
    startCursor: event.startCursor,
    endCursor: event.endCursor,
    stream: event.stream,
    observedAt: event.observedAt,
    content: neutralizeTerminalControls(decoded.text),
    ...(decoded.loss ? { decodingLoss: true } : {}),
  };
}

export function presentEvents(
  events: readonly OutputEvent[],
  view: OutputView,
): { events: PresentedOutputEvent[]; decodingLoss: boolean } {
  const presented = events.map((event) => presentEvent(event, view));
  return {
    events: presented,
    decodingLoss: presented.some((event) => event.decodingLoss === true),
  };
}
