import { describe, expect, it } from "vitest";
import {
  APP_EVENT_VERSION,
  asSessionId,
  asToolCallId,
  isDeltaEvent,
  isStructuralEvent,
} from "../../src/app/events/app-event.js";
import {
  EventSequencer,
  createCountingIdFactory,
} from "../../src/app/events/sequencer.js";
import {
  BoundedText,
  OutputSpool,
} from "../../src/app/events/event-buffer.js";
import { AgentEventAdapter } from "../../src/app/adapters/agent-event-adapter.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";
import type { AgentEvent } from "../../src/agent/events.js";
import type { SessionPlan } from "../../src/store/plan.js";

const fixedClock = { now: () => 1_700_000_000_000 };

function sequencer(prefix = "") {
  return new EventSequencer(
    asSessionId("sess-test"),
    createCountingIdFactory(prefix),
    fixedClock,
  );
}

describe("V2-020 AppEvent envelope + sequencer", () => {
  it("assigns a monotonic, gap-free sequence starting at 1", () => {
    const seq = sequencer();
    const a = seq.build("status", { text: "step 1", step: 1 });
    const b = seq.build("assistant-delta", { text: "hi" });
    const c = seq.build("turn-aborted", {});
    expect([a.sequence, b.sequence, c.sequence]).toEqual([1, 2, 3]);
    expect(a.version).toBe(APP_EVENT_VERSION);
    expect(a.sessionId).toBe("sess-test");
    expect(a.timestamp).toBe(1_700_000_000_000);
  });

  it("omits turnId when not provided and includes it when provided", () => {
    const seq = sequencer();
    const without = seq.build("notice", { level: "info", text: "x" });
    const withTurn = seq.build(
      "notice",
      { level: "info", text: "y" },
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
      "turn-1" as never,
    );
    expect(without.turnId).toBeUndefined();
    expect(withTurn.turnId).toBe("turn-1");
  });

  it("classifies delta vs structural events", () => {
    expect(isDeltaEvent("assistant-delta")).toBe(true);
    expect(isDeltaEvent("thinking-delta")).toBe(true);
    expect(isDeltaEvent("tool-call")).toBe(false);
    expect(isStructuralEvent("tool-call")).toBe(true);
    expect(isStructuralEvent("assistant-delta")).toBe(false);
  });
});

describe("V2-020 BoundedText + OutputSpool", () => {
  it("keeps only the tail while tracking total and dropped bytes", () => {
    const buf = new BoundedText(5);
    buf.append("abc");
    expect(buf.tail).toBe("abc");
    expect(buf.truncated).toBe(false);
    buf.append("defgh");
    expect(buf.tail).toBe("defgh");
    expect(buf.totalBytes).toBe(8);
    expect(buf.droppedBytes).toBe(3);
    expect(buf.truncated).toBe(true);
  });

  it("spools per tool call and returns a reference, not the string", () => {
    const spool = new OutputSpool(4);
    const id = asToolCallId("call-1");
    const ref1 = spool.append(id, "12");
    expect(ref1).toEqual({ toolCallId: id, chunkBytes: 2, totalBytes: 2 });
    const ref2 = spool.append(id, "3456");
    expect(ref2.totalBytes).toBe(6);
    expect(spool.tail(id)).toBe("3456");
    expect(spool.state(id)?.truncated).toBe(true);
    expect(spool.tail(asToolCallId("missing"))).toBe("");
  });
});

const plan: SessionPlan = {
  sessionId: "sess-test",
  goal: "goal",
  detail: "detail",
  tasks: [{ id: "t1", title: "one", state: "pending" }],
  status: "draft",
  kind: "general",
  createdAt: "now",
  updatedAt: "now",
};

function collectFrom(events: AgentEvent[], prefix = ""): AnyAppEvent[] {
  const out: AnyAppEvent[] = [];
  const spool = new OutputSpool();
  const adapter = new AgentEventAdapter(sequencer(prefix), spool, (e) =>
    out.push(e),
  );
  for (const e of events) adapter.ingest(e);
  return out;
}

const scriptedAgentEvents: AgentEvent[] = [
  { type: "turn-start", prompt: "do it" },
  { type: "status", text: "step 1" },
  { type: "assistant-delta", text: "hello " },
  { type: "assistant-delta", text: "world" },
  { type: "tool-call", id: "c1", name: "fs.read", argsDisplay: "a.ts" },
  { type: "tool-output", id: "c1", chunk: "line1\n" },
  { type: "tool-output", id: "c1", chunk: "line2\n" },
  { type: "tool-result", id: "c1", ok: true, summary: "read", exitCode: 0 },
  { type: "plan-update", plan },
  { type: "assistant-message", text: "done" },
  { type: "turn-end", finalAnswer: "done", steps: 1 },
];

describe("V2-021 AgentEventAdapter", () => {
  it("translates every AgentEvent kind to a versioned envelope", () => {
    const out = collectFrom(scriptedAgentEvents);
    expect(out.map((e) => e.type)).toEqual([
      "turn-started",
      "status",
      "assistant-delta",
      "assistant-delta",
      "tool-call",
      "tool-output",
      "tool-output",
      "tool-result",
      "plan-updated",
      "assistant-message",
      "turn-ended",
    ]);
    expect(out.every((e, i) => e.sequence === i + 1)).toBe(true);
  });

  it("references tool output through the spool instead of inlining strings", () => {
    const spool = new OutputSpool();
    const out: AnyAppEvent[] = [];
    const adapter = new AgentEventAdapter(sequencer(), spool, (e) =>
      out.push(e),
    );
    adapter.ingest({ type: "tool-call", id: "c1", name: "sh", argsDisplay: "" });
    adapter.ingest({ type: "tool-output", id: "c1", chunk: "big output" });
    const outputEvent = out.find((e) => e.type === "tool-output");
    expect(outputEvent?.payload).toEqual({
      ref: { toolCallId: "c1", chunkBytes: 10, totalBytes: 10 },
    });
    expect(spool.tail(asToolCallId("c1"))).toBe("big output");
  });

  it("parses step numbers from status text", () => {
    const [status] = collectFrom([{ type: "status", text: "step 7" }]);
    expect(status?.payload).toEqual({ text: "step 7", step: 7 });
  });

  it("produces byte-identical output on replay with a deterministic id factory", () => {
    const first = collectFrom(scriptedAgentEvents, "run-");
    const second = collectFrom(scriptedAgentEvents, "run-");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});
