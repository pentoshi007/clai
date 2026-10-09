import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PASTE_BURST_GLUE_MS,
  PASTE_BURST_SETTLE_MS,
  PasteBurstDetector,
  type BurstOutput,
  type BurstUnit,
} from "../../../src/ui-core/input/paste-burst.js";
import { normalizePasteLineBreaks } from "../../../src/ui-core/input/paste-text.js";

const OTHER = "\u0000";

function read(text: string): BurstUnit<string>[] {
  return [...text].map((char) => {
    if (char === "\r" || char === "\n") return { kind: "break", text: char, source: char };
    if (char === "\t") return { kind: "tab", text: char, source: char };
    if (char === OTHER) return { kind: "other", text: "", source: char };
    return { kind: "content", text: char, source: char };
  });
}

function show(outputs: readonly BurstOutput<string>[]): string[] {
  return outputs.map((output) =>
    output.type === "paste" ? `paste:${JSON.stringify(output.text)}` : `key:${JSON.stringify(output.source)}`,
  );
}

function withoutConsecutiveBlankLines(lines: readonly string[]): string[] {
  const result: string[] = [];
  for (const line of lines) result.push(line === "" && result.at(-1) === "" ? "_" : line);
  return result;
}

function detector(): PasteBurstDetector<string> {
  return new PasteBurstDetector<string>({ normalize: normalizePasteLineBreaks });
}

function typed(instance: PasteBurstDetector<string>, text: string, startAt: number, gap = 100): number {
  let now = startAt;
  for (const char of text) {
    instance.process(read(char), now);
    now += gap;
  }
  return now;
}

describe("PasteBurstDetector", () => {
  it("keeps rapid Tab and Enter as shortcuts after typed command text", () => {
    for (const together of [true, false]) {
      const instance = detector();
      instance.process(read("/he"), 0);
      const outputs = together
        ? instance.process(read("\t\r"), 1)
        : [...instance.process(read("\t"), 1), ...instance.process(read("\r"), 2)];
      expect(show(outputs)).toEqual(['key:"\\t"', 'key:"\\r"']);
      expect(instance.pendingDeadline).toBeUndefined();
    }
  });

  it("retains tabs in a single-line paste and across fragments of a pending multiline paste", () => {
    const single = detector();
    single.process(read("key\tvalue"), 0);
    expect(single.expire(PASTE_BURST_SETTLE_MS)).toEqual([{ type: "paste", text: "key\tvalue" }]);
    const multiline = detector();
    multiline.process(read("line one\rline two"), 0);
    multiline.process(read("\t\r"), 20);
    multiline.process(read("line three"), 40);
    expect(multiline.expire(40 + PASTE_BURST_SETTLE_MS)).toEqual([{ type: "paste", text: "line one\nline two\t\nline three" }]);
    const indented = detector();
    indented.process(read("first line"), 0);
    expect(indented.process(read("\r\t"), 20)).toEqual([]);
    expect(indented.process(read("\r"), 40)).toEqual([]);
    expect(indented.expire(40 + PASTE_BURST_SETTLE_MS)).toEqual([{ type: "paste", text: "\n\t\n" }]);
  });

  it("passes single keystrokes straight through without scheduling anything", () => {
    const instance = detector();
    expect(show(instance.process(read("a"), 0))).toEqual(['key:"a"']);
    expect(show(instance.process(read("b"), 120))).toEqual(['key:"b"']);
    expect(show(instance.process(read("\r"), 400))).toEqual(['key:"\\r"']);
    expect(instance.pendingDeadline).toBeUndefined();
  });

  it("turns a multi-line read into one paste once input settles", () => {
    const instance = detector();
    expect(instance.process(read("one\rtwo\r\rthree"), 0)).toEqual([]);
    expect(instance.pendingDeadline).toBe(PASTE_BURST_SETTLE_MS);
    expect(instance.expire(PASTE_BURST_SETTLE_MS - 1)).toEqual([]);
    expect(instance.expire(PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "one\ntwo\n\nthree" },
    ]);
    expect(instance.pendingDeadline).toBeUndefined();
  });

  it("keeps a paste together when each line arrives as its own read, far apart", () => {
    const instance = detector();
    const gap = PASTE_BURST_SETTLE_MS - 10;
    const lines = ["Write a CSV parser", "", "Requirements:", "- quoted fields"];
    const emitted: BurstOutput<string>[] = [];
    lines.forEach((line, index) => {
      emitted.push(...instance.process(read(`${line}\r`), index * gap));
    });
    emitted.push(...instance.expire(Number.MAX_SAFE_INTEGER));
    expect(show(emitted)).toEqual([
      `paste:${JSON.stringify("Write a CSV parser\n\nRequirements:\n- quoted fields\n")}`,
    ]);
  });

  it("keeps a paste together when each line arrives with its Enter in front, including blank lines", () => {
    const instance = detector();
    const gap = PASTE_BURST_SETTLE_MS - 10;
    const reads = ["First line here", "\r", "\rSecond line", "\r", "\rThird line"];
    const emitted: BurstOutput<string>[] = [];
    reads.forEach((value, index) => {
      emitted.push(...instance.process(read(value), index * gap));
    });
    emitted.push(...instance.expire(Number.MAX_SAFE_INTEGER));
    const keys = emitted.filter((output) => output.type === "event");
    expect(keys.map((output) => output.source).join("")).toBe("First line here");
    expect(emitted.at(-1)).toEqual({ type: "paste", text: "\n\nSecond line\n\nThird line" });
  });

  it("never lets an Enter escape a line-split paste at any gap inside the window", () => {
    const body = fc.stringMatching(/^[a-z0-9\t ]{0,16}$/);
    const lead = fc.stringMatching(/^[a-z]{3,16}$/);
    const style = fc.constantFrom("after", "before");
    const gap = fc.integer({ min: 0, max: PASTE_BURST_SETTLE_MS - 1 });
    fc.assert(
      fc.property(
        lead,
        fc.array(body, { minLength: 2, maxLength: 12 }),
        style,
        fc.array(gap, { minLength: 13, maxLength: 13 }),
        (first, rest, mode, gaps) => {
          const instance = detector();
          const lines = mode === "after" ? [first, ...rest] : withoutConsecutiveBlankLines([first, ...rest]);
          const reads =
            mode === "after"
              ? lines.map((line) => `${line}\r`)
              : lines.map((line, index) => (index === 0 ? line : `\r${line}`));
          const emitted: BurstOutput<string>[] = [];
          let now = 0;
          reads.forEach((value, index) => {
            now += index === 0 ? 0 : (gaps[index] as number);
            emitted.push(...instance.expire(now));
            emitted.push(...instance.process(read(value), now));
          });
          emitted.push(...instance.expire(Number.MAX_SAFE_INTEGER));

          const breakKeys = emitted.filter((output) => output.type === "event" && output.source === "\r");
          expect(breakKeys).toEqual([]);
          const received = emitted
            .map((output) => (output.type === "paste" ? output.text : output.source))
            .join("");
          const expected = mode === "after"
            ? lines.map((line) => `${line}\n`).join("")
            : lines.map((line, index) => (index === 0 ? line : `\n${line}`)).join("");
          expect(received).toBe(expected);
        },
      ),
      { numRuns: 1_500 },
    );
  });

  it("joins an Enter that arrives right behind the text before it", () => {
    const instance = detector();
    instance.process(read("line1"), 0);
    expect(instance.process(read("\r"), PASTE_BURST_GLUE_MS)).toEqual([]);
    expect(instance.process(read("line2"), PASTE_BURST_GLUE_MS + 5)).toEqual([]);
    expect(instance.expire(PASTE_BURST_GLUE_MS + 5 + PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "\nline2" },
    ]);
  });

  it("submits an Enter typed after single keystrokes without any delay", () => {
    const instance = detector();
    const next = typed(instance, "abc", 0);
    expect(show(instance.process(read("\r"), next + PASTE_BURST_GLUE_MS + 1))).toEqual(['key:"\\r"']);
    expect(instance.pendingDeadline).toBeUndefined();
  });

  it("holds a lone Enter that follows a multi-character read, then releases it as a keypress", () => {
    const instance = detector();
    instance.process(read("abc"), 0);
    const arrival = PASTE_BURST_GLUE_MS + 1;
    expect(instance.process(read("\r"), arrival)).toEqual([]);
    expect(instance.pendingDeadline).toBe(arrival + PASTE_BURST_SETTLE_MS);
    expect(instance.expire(arrival + PASTE_BURST_SETTLE_MS - 1)).toEqual([]);
    expect(show(instance.expire(arrival + PASTE_BURST_SETTLE_MS))).toEqual(['key:"\\r"']);
  });

  it("releases a held lone Enter as a keypress when a second lone Enter arrives after the glue window", () => {
    const instance = detector();
    instance.process(read("/help"), 0);
    expect(instance.process(read("\r"), 200)).toEqual([]);
    expect(show(instance.process(read("\r"), 350))).toEqual(['key:"\\r"', 'key:"\\r"']);
    expect(instance.pendingDeadline).toBeUndefined();
  });

  it("merges a held lone Enter with another one that follows inside the glue window", () => {
    const instance = detector();
    instance.process(read("/help"), 0);
    instance.process(read("\r"), 200);
    expect(instance.process(read("\r"), 200 + PASTE_BURST_GLUE_MS)).toEqual([]);
    expect(instance.expire(200 + PASTE_BURST_GLUE_MS + PASTE_BURST_SETTLE_MS)).toEqual([
      { type: "paste", text: "\n\n" },
    ]);
  });

  it("turns that held Enter into a newline when the paste carries on", () => {
    const instance = detector();
    instance.process(read("abc"), 0);
    instance.process(read("\r"), 100);
    expect(instance.process(read("def"), 160)).toEqual([]);
    expect(instance.expire(160 + PASTE_BURST_SETTLE_MS)).toEqual([{ type: "paste", text: "\ndef" }]);
  });

  it("submits an Enter that follows a multi-character read after the settle window", () => {
    const instance = detector();
    instance.process(read("abc"), 0);
    expect(show(instance.process(read("\r"), PASTE_BURST_SETTLE_MS + 1))).toEqual(['key:"\\r"']);
  });

  it("holds a short trailing line and releases it as keys when nothing follows", () => {
    const instance = detector();
    expect(instance.process(read("ok\r"), 0)).toEqual([]);
    expect(instance.pendingDeadline).toBe(PASTE_BURST_SETTLE_MS);
    expect(show(instance.expire(PASTE_BURST_SETTLE_MS))).toEqual(['key:"o"', 'key:"k"', 'key:"\\r"']);
  });

  it("leaves type-ahead after an Enter alone once the preceding read is long past", () => {
    const instance = detector();
    instance.process(read("/help"), 0);
    const events = read("\rqresize smoke");
    expect(show(instance.process(events, PASTE_BURST_SETTLE_MS + 1))).toEqual(
      events.map((unit) => `key:${JSON.stringify(unit.source)}`),
    );
    expect(instance.pendingDeadline).toBeUndefined();
  });

  it("joins a leading Enter and its text to a multi-character read that just arrived", () => {
    const instance = detector();
    instance.process(read("/help"), 0);
    expect(instance.process(read("\rqresize smoke"), PASTE_BURST_SETTLE_MS)).toEqual([]);
    expect(instance.expire(PASTE_BURST_SETTLE_MS * 2)).toEqual([
      { type: "paste", text: "\nqresize smoke" },
    ]);
  });

  it("forgets multi-character evidence once a non-text unit intervenes", () => {
    const instance = detector();
    instance.process(read("abc"), 0);
    instance.process(read(OTHER), 10);
    expect(show(instance.process(read("\r"), PASTE_BURST_GLUE_MS + 11))).toEqual(['key:"\\r"']);
    expect(instance.pendingDeadline).toBeUndefined();
  });

  it("releases a pending line before a non-text unit and keeps their order", () => {
    const held = detector();
    held.process(read("hi\r"), 0);
    expect(show(held.process(read(OTHER), 5))).toEqual(['key:"h"', 'key:"i"', 'key:"\\r"', `key:${JSON.stringify(OTHER)}`]);

    const collecting = detector();
    collecting.process(read("a\rb"), 0);
    expect(show(collecting.process(read(OTHER), 50))).toEqual([
      `paste:${JSON.stringify("a\nb")}`,
      `key:${JSON.stringify(OTHER)}`,
    ]);
  });

  it("never folds a read containing a non-text unit into a paste", () => {
    const instance = detector();
    const units = read(`a\r${OTHER}`);
    expect(instance.process(units, 0)).toEqual(units.map((unit) => ({ type: "event", source: unit.source })));
    expect(instance.pendingDeadline).toBeUndefined();
  });

  it("counts CRLF as a single line break", () => {
    const instance = detector();
    expect(instance.process(read("ab\r\n"), 0)).toEqual([]);
    expect(show(instance.expire(PASTE_BURST_SETTLE_MS))).toEqual(['key:"a"', 'key:"b"', 'key:"\\r"', 'key:"\\n"']);

    const pasted = detector();
    pasted.process(read("a\r\nb"), 0);
    expect(pasted.expire(PASTE_BURST_SETTLE_MS)).toEqual([{ type: "paste", text: "a\nb" }]);
  });

  it("leaves an isolated line feed alone", () => {
    const instance = detector();
    expect(show(instance.process(read("\n"), 0))).toEqual(['key:"\\n"']);
  });

  it("flushes pending text on demand and honours deadlines otherwise", () => {
    const instance = detector();
    instance.process(read("one\rtwo"), 0);
    expect(instance.expire(10)).toEqual([]);
    expect(instance.flush()).toEqual([{ type: "paste", text: "one\ntwo" }]);
    expect(instance.flush()).toEqual([]);
    expect(instance.pendingDeadline).toBeUndefined();
  });

  it("applies the normalize hook to pasted text only", () => {
    const instance = new PasteBurstDetector<string>({ normalize: (text) => text.toUpperCase() });
    instance.process(read("ab\rcd"), 0);
    expect(instance.expire(PASTE_BURST_SETTLE_MS)).toEqual([{ type: "paste", text: "AB\rCD" }]);
  });

  it("honours custom windows", () => {
    const instance = new PasteBurstDetector<string>({ settleMs: 1_000, glueMs: 5 });
    instance.process(read("one\rtwo"), 0);
    expect(instance.pendingDeadline).toBe(1_000);
    expect(instance.process(read("\rthree"), 900)).toEqual([]);
    expect(instance.pendingDeadline).toBe(1_900);
  });

  it("never drops or reorders content whatever the chunking and timing", () => {
    const chunk = fc.stringMatching(/^[a-z \r\t]{1,8}$/);
    const step = fc.record({ bytes: chunk, gap: fc.integer({ min: 0, max: 600 }) });
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 14 }), (steps) => {
        const instance = detector();
        const emitted: BurstOutput<string>[] = [];
        let sent = "";
        let now = 0;
        for (const { bytes, gap } of steps) {
          now += gap;
          emitted.push(...instance.expire(now));
          sent += bytes;
          emitted.push(...instance.process(read(bytes), now));
        }
        emitted.push(...instance.expire(Number.MAX_SAFE_INTEGER));
        const received = emitted
          .map((output) =>
            output.type === "paste" ? output.text : output.source.replace("\r", "\n"),
          )
          .join("");
        expect(received).toBe(sent.replace(/\r/g, "\n"));
        expect(instance.pendingDeadline).toBeUndefined();
      }),
      { numRuns: 2_000 },
    );
  });
});
