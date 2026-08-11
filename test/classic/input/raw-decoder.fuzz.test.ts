import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DecodedEvent } from "../../../src/classic/input/key-event.js";
import { RawDecoder } from "../../../src/classic/input/raw-decoder.js";

const INTERESTING = [
  "\x1b",
  "\x1b[",
  "\x1bO",
  "\x1b]",
  "\x1b[200~",
  "\x1b[201~",
  "\x1b[<0;1;1M",
  "\x1b[13;2u",
  "\x1b[1;5A",
  "\r",
  "\n",
  "\t",
  "\x03",
  "\x7f",
  "\x00",
  ";",
  "5",
  "~",
  "u",
  "a",
  "漢",
  "👍",
  "\x07",
  "\x1b\\",
];

const chunkArb = fc.oneof(
  fc.constantFrom(...INTERESTING),
  fc.string({ minLength: 0, maxLength: 6 }),
  fc.string({ minLength: 0, maxLength: 6, unit: "binary" }),
);

const streamArb = fc.array(chunkArb, { minLength: 1, maxLength: 12 });

function decodeChunks(chunks: readonly string[], mouse: boolean): DecodedEvent[] {
  const decoder = new RawDecoder({ mouse });
  const events: DecodedEvent[] = [];
  for (const chunk of chunks) events.push(...decoder.push(chunk));
  events.push(...decoder.flush());
  expect(decoder.pending).toBe(false);
  return events;
}

describe("raw decoder fuzz", () => {
  // 10,000 runs is comfortably fast alone but competes with the rest of the
  // suite for cores, so the budget is generous rather than the 5 s default.
  it("never throws, never leaks an escape into key text, and always drains", () => {
    fc.assert(
      fc.property(streamArb, fc.boolean(), (chunks, mouse) => {
        const events = decodeChunks(chunks, mouse);
        for (const event of events) {
          if (event.type === "key") {
            expect(event.key.text).not.toContain("\x1b");
            expect(event.key.name).not.toContain("\x1b");
          }
          if (event.type === "paste") expect(event.text).not.toContain("\x1b");
          if (event.type === "mouse") expect(mouse).toBe(true);
        }
      }),
      { numRuns: 10_000 },
    );
  }, 60_000);

  it("preserves the decoded payload regardless of chunk boundaries", () => {
    fc.assert(
      fc.property(streamArb, (chunks) => {
        const payload = (events: readonly DecodedEvent[]): string =>
          events
            .map((event) =>
              event.type === "key" ? event.key.text : event.type === "paste" ? event.text : "",
            )
            .join("");
        expect(payload(decodeChunks(chunks, true))).toBe(
          payload(decodeChunks([chunks.join("")], true)),
        );
      }),
      { numRuns: 2_000 },
    );
  });

  it("is independent of chunk boundaries for escape sequences and pastes", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...INTERESTING), { minLength: 1, maxLength: 10 }),
        (chunks) => {
          const input = chunks.join("");
          const whole = decodeChunks([input], true);
          let at = 0;
          for (const codePoint of input) {
            at += codePoint.length;
            if (at >= input.length) break;
            expect(decodeChunks([input.slice(0, at), input.slice(at)], true)).toEqual(whole);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("emits no key event carrying a control byte as text", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 40, unit: "binary" }), (input) => {
        for (const event of decodeChunks([input], false)) {
          if (event.type !== "key") continue;
          for (const char of event.key.text) {
            const code = char.charCodeAt(0);
            expect(code === 0x09 || code >= 0x20).toBe(true);
          }
        }
      }),
      { numRuns: 5_000 },
    );
  });
});
