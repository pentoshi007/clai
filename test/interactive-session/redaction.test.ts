import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  REDACTION_MARKER,
  StreamingSecretRedactor,
  splitUtf8Runs,
  trailingIncompleteUtf8Bytes,
} from "../../src/interactive-session/streaming-redactor.js";
import { makeStore, MemorySink } from "./helpers.js";
import { SessionErrorException } from "../../src/interactive-session/types.js";

const CANARY = "hunter2-canary-value";

function feed(redactor: StreamingSecretRedactor, bytes: Uint8Array, chunkSize: number): Uint8Array {
  const parts: number[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    parts.push(...redactor.push(bytes.subarray(offset, offset + chunkSize)));
  }
  parts.push(...redactor.close());
  return new Uint8Array(parts);
}

// Feature: interactive-terminal-sessions, Property 15: Sensitive data never reaches a persistence or presentation sink
describe("Property 15: sensitive data never reaches a persistence or presentation sink", () => {
  it("redacts an exact secret across every chunk split", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }),
        fc.string({ maxLength: 30 }),
        fc.integer({ min: 1, max: 12 }),
        (prefix, suffix, chunkSize) => {
          const redactor = new StreamingSecretRedactor(4_096);
          redactor.registerExactSecret(CANARY);
          const source = new Uint8Array(Buffer.from(`${prefix}${CANARY}${suffix}`, "utf8"));
          const emitted = feed(redactor, source, chunkSize);
          const text = Buffer.from(emitted).toString("utf8");
          expect(text).not.toContain(CANARY);
          expect(text).toContain(REDACTION_MARKER);
          expect(redactor.redacted).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it.each(["aaaa", "abcabc", "試験試験", "abab"])("redacts self-overlapping exact secret %s across every split", (secret) => {
    const source = Buffer.from(`value=${secret}`);
    for (let chunkSize = 1; chunkSize <= source.length; chunkSize += 1) {
      const redactor = new StreamingSecretRedactor(4_096);
      redactor.registerExactSecret(secret);
      const text = Buffer.from(feed(redactor, source, chunkSize)).toString("utf8");
      expect(text).not.toContain(secret);
      expect(text).toContain(REDACTION_MARKER);
    }
  });

  it("redacts a secret adjacent to invalid UTF-8 bytes", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10 }), (chunkSize) => {
        const redactor = new StreamingSecretRedactor(4_096);
        redactor.registerExactSecret(CANARY);
        const source = new Uint8Array([
          0xff,
          0xfe,
          ...Buffer.from(CANARY, "utf8"),
          0xc3,
          0x28,
        ]);
        const emitted = feed(redactor, source, chunkSize);
        expect(Buffer.from(emitted).includes(Buffer.from(CANARY, "utf8"))).toBe(false);
        // Surrounding binary bytes are preserved, not swallowed.
        expect(emitted[0]).toBe(0xff);
        expect(emitted.at(-1)).toBe(0x28);
      }),
      { numRuns: 100 },
    );
  });

  it("applies textual secret patterns to valid decoded runs", () => {
    const redactor = new StreamingSecretRedactor(4_096);
    const emitted = feed(
      redactor,
      new Uint8Array(Buffer.from("token sk-abcdef1234567890 end", "utf8")),
      7,
    );
    const text = Buffer.from(emitted).toString("utf8");
    expect(text).not.toContain("sk-abcdef1234567890");
    expect(text).toContain("sk-••••••");
  });

  it("rejects an exact secret longer than the configured match span", () => {
    const redactor = new StreamingSecretRedactor(8);
    expect(() => redactor.registerExactSecret("a".repeat(64))).toThrow(SessionErrorException);
  });

  it("keeps secrets out of the store, artifact bytes, and both views", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9 }), (chunkSize) => {
        const sink = new MemorySink();
        const { store } = makeStore({ sink });
        store.registerExactSecret(CANARY);
        const source = new Uint8Array(Buffer.from(`user ${CANARY} done\n`, "utf8"));
        for (let offset = 0; offset < source.length; offset += chunkSize) {
          store.ingest("stdout", source.subarray(offset, offset + chunkSize), 0);
        }
        store.finish();
        const needle = Buffer.from(CANARY, "utf8");
        expect(Buffer.from(sink.bytes()).includes(needle)).toBe(false);
        for (const view of ["plain", "encoded"] as const) {
          const page = store.page({
            cursor: 0,
            view,
            maxBytes: 1_048_576,
            operation: "read",
            sessionId: "s",
          });
          const content = page.page.events.map((event) => event.content).join("");
          expect(content).not.toContain(CANARY);
          if (view === "encoded") {
            expect(Buffer.from(content, "base64").includes(needle)).toBe(false);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("emits prompt text immediately instead of holding it as overlap", () => {
    const redactor = new StreamingSecretRedactor(4_096);
    const emitted = redactor.push(new Uint8Array(Buffer.from(">>> ", "utf8")));
    expect(Buffer.from(emitted).toString("utf8")).toBe(">>> ");
  });
});

describe("UTF-8 boundary helpers", () => {
  it("reports only genuinely incomplete trailing sequences", () => {
    expect(trailingIncompleteUtf8Bytes(new Uint8Array(Buffer.from("ok", "utf8")))).toBe(0);
    const euro = new Uint8Array(Buffer.from("€", "utf8"));
    expect(trailingIncompleteUtf8Bytes(euro.subarray(0, 2))).toBe(2);
    expect(trailingIncompleteUtf8Bytes(euro)).toBe(0);
  });

  it("splits arbitrary bytes into lossless valid and invalid runs", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 120 }),
        (bytes) => {
          const source = new Uint8Array(bytes);
          const runs = splitUtf8Runs(source);
          const rejoined = new Uint8Array(runs.flatMap((run) => [...run.bytes]));
          expect(rejoined).toEqual(source);
          for (const run of runs) {
            if (!run.valid) continue;
            // A valid run round-trips exactly; only invalid runs would lose bytes.
            const text = Buffer.from(run.bytes).toString("utf8");
            expect(new Uint8Array(Buffer.from(text, "utf8"))).toEqual(run.bytes);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
