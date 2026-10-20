import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../../src/app/ports/transcript-item.js";
import type { ChatMessage } from "../../src/types.js";
import type { HistoryRecord } from "../../src/store/history/recovery.js";
import { planBaseFrame, planSessionFrame, SessionReplay, stateFromReplay, type SessionLogState } from "../../src/store/history/session-frames.js";
import { useIsolatedHistory } from "../fixtures/isolated-history.js";

const text = fc.oneof(fc.string(), fc.string({ unit: "grapheme" }), fc.string({ unit: "binary" }), fc.constantFrom("", "日本語 🧪", "a\nb\r\n\"quoted\"\\"));

type Op =
  | { kind: "message"; content: string }
  | { kind: "item"; content: string }
  | { kind: "edit"; at: number; content: string }
  | { kind: "remove"; at: number }
  | { kind: "insert"; at: number; content: string }
  | { kind: "compact"; keep: number; summary: string }
  | { kind: "rename"; name: string }
  | { kind: "toggle-transcript" }
  | { kind: "writer" };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("message" as const), content: text }),
  fc.record({ kind: fc.constant("item" as const), content: text }),
  fc.record({ kind: fc.constant("edit" as const), at: fc.nat(), content: text }),
  fc.record({ kind: fc.constant("remove" as const), at: fc.nat() }),
  fc.record({ kind: fc.constant("insert" as const), at: fc.nat(), content: text }),
  fc.record({ kind: fc.constant("compact" as const), keep: fc.nat(), summary: text }),
  fc.record({ kind: fc.constant("rename" as const), name: text }),
  fc.record({ kind: fc.constant("toggle-transcript" as const) }),
  fc.record({ kind: fc.constant("writer" as const) }),
);

interface Model {
  messages: ChatMessage[];
  transcript: TranscriptItem[] | undefined;
  name: string;
  writer: number;
  revision: number;
  serial: number;
}

function apply(model: Model, step: Op): Model {
  const next: Model = { ...model, messages: [...model.messages], transcript: model.transcript ? [...model.transcript] : undefined, revision: model.revision + 1 };
  const transcript = next.transcript ?? [];
  const item = (content: string): TranscriptItem => ({ kind: "assistant", id: `item-${(next.serial += 1)}`, text: content, done: true });
  switch (step.kind) {
    case "message":
      next.messages.push({ role: next.messages.length % 2 === 0 ? "user" : "assistant", content: step.content });
      break;
    case "item":
      next.transcript = [...transcript, item(step.content)];
      break;
    case "edit":
      if (transcript.length > 0) {
        const at = step.at % transcript.length;
        transcript[at] = { ...transcript[at]!, text: step.content } as TranscriptItem;
        next.transcript = transcript;
      }
      break;
    case "remove":
      if (transcript.length > 0) {
        transcript.splice(step.at % transcript.length, 1);
        next.transcript = transcript;
      }
      break;
    case "insert":
      transcript.splice(step.at % (transcript.length + 1), 0, item(step.content));
      next.transcript = transcript;
      break;
    case "compact":
      next.messages = [{ role: "user", content: `[memory] ${step.summary}` }, ...next.messages.slice(Math.min(next.messages.length, step.keep % 4))];
      break;
    case "rename":
      next.name = step.name;
      break;
    case "toggle-transcript":
      next.transcript = next.transcript ? undefined : [];
      break;
    case "writer":
      next.writer += 1;
      next.revision = 1;
      break;
  }
  return next;
}

function recordOf(model: Model): HistoryRecord {
  return {
    id: "prop-session",
    writerGeneration: `000${model.writer}-writer`,
    revision: model.revision,
    name: model.name,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + model.revision * 1000).toISOString(),
    cwd: "/repo",
    messages: model.messages,
    ...(model.transcript ? { transcript: model.transcript } : {}),
  };
}

function roundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function replay(lines: readonly string[]): HistoryRecord | undefined {
  const replayer = new SessionReplay("prop-session");
  for (const line of lines) replayer.accept(line.slice(0, -1), Buffer.byteLength(line));
  return replayer.result()?.record;
}

const initial: Model = { messages: [], transcript: [], name: "", writer: 1, revision: 0, serial: 0 };

describe("session frame log", () => {
  it("replays any sequence of base and delta frames to the last written record", () => {
    fc.assert(fc.property(fc.array(fc.tuple(op, fc.boolean()), { maxLength: 30 }), (steps) => {
      let model = initial;
      let state: SessionLogState | undefined;
      const lines: string[] = [];
      for (const [step, forceBase] of steps) {
        model = apply(model, step);
        const record = recordOf(model);
        const planned = planSessionFrame(state, record, { forceBase });
        lines.push(planned.line);
        state = planned.state;
        expect(replay(lines)).toEqual(roundTrip(record));
      }
    }), { numRuns: 300 });
  });

  it("rebuilds the same digests from disk as the writer kept in memory", () => {
    fc.assert(fc.property(fc.array(op, { minLength: 1, maxLength: 20 }), (steps) => {
      let model = initial;
      let state: SessionLogState | undefined;
      const lines: string[] = [];
      for (const step of steps) {
        model = apply(model, step);
        const planned = planSessionFrame(state, recordOf(model));
        lines.push(planned.line);
        state = planned.state;
      }
      const replayer = new SessionReplay("prop-session");
      for (const line of lines) replayer.accept(line.slice(0, -1), Buffer.byteLength(line));
      const rebuilt = stateFromReplay(replayer.result()!);
      expect(rebuilt.messageDigests).toEqual(state!.messageDigests);
      expect(rebuilt.transcriptDigests).toEqual(state!.transcriptDigests);
      expect(rebuilt.seq).toBe(state!.seq);
    }), { numRuns: 200 });
  });

  it("stops at the first frame that is out of sequence, malformed or for another session", () => {
    const first = planBaseFrame(0, recordOf(apply(initial, { kind: "message", content: "one" })));
    const second = planSessionFrame(first.state, recordOf(apply(apply(initial, { kind: "message", content: "one" }), { kind: "message", content: "two" })));
    const replayed = (lines: string[]) => replay(lines)?.messages.map((message) => message.content);
    expect(replayed([first.line, second.line])).toEqual(["one", "two"]);
    expect(replayed([first.line, second.line.replace('"seq":1', '"seq":5')])).toEqual(["one"]);
    expect(replayed([first.line, "{not json\n", second.line])).toEqual(["one"]);
    expect(replayed([first.line, second.line.replaceAll("prop-session", "other-session")])).toEqual(["one"]);
    expect(replayed([second.line])).toBeUndefined();
  });

  it("writes only what changed since the previous frame", () => {
    let model = initial;
    for (let index = 0; index < 200; index += 1) model = apply(apply(model, { kind: "message", content: `message ${index} ${"x".repeat(500)}` }), { kind: "item", content: `item ${index} ${"y".repeat(500)}` });
    const base = planSessionFrame(undefined, recordOf(model));
    const next = planSessionFrame(base.state, recordOf(apply(model, { kind: "item", content: "new" })));
    expect(next.kind).toBe("delta");
    expect(next.bytes).toBeLessThan(2_048);
    expect(base.bytes).toBeGreaterThan(200_000);
  });
});

describe("session store round trip", () => {
  useIsolatedHistory("clai-session-frames-");

  it("returns exactly what the full-record format returned after every save", async () => {
    const history = await import("../../src/store/history.js");
    const { hydrateHistoryRecord } = await import("../../src/store/history/recovery.js");
    await fc.assert(fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 12 }), fc.uuid(), async (steps, uuid) => {
      const id = `prop-${uuid}`;
      let model = initial;
      for (const step of steps) {
        model = apply(model, step);
        const canonical = await history.upsertSession(
          id,
          model.messages,
          model.name || undefined,
          model.transcript,
          undefined,
          model.revision,
          `000${model.writer}-writer`,
        );
        expect(await history.getSession(id)).toEqual(hydrateHistoryRecord(roundTrip(canonical)));
      }
    }), { numRuns: 25 });
  }, 60_000);
});
