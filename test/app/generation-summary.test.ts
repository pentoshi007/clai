import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/agent/events.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { AgentEventAdapter } from "../../src/app/adapters/agent-event-adapter.js";
import { asSessionId, asTurnId, type AnyAppEvent } from "../../src/app/events/app-event.js";
import { OutputSpool } from "../../src/app/events/event-buffer.js";
import { createCountingIdFactory, EventSequencer } from "../../src/app/events/sequencer.js";
import type { TranscriptItem } from "../../src/app/ports/transcript-item.js";
import { tokensPerSecondLabel } from "../../src/ui-core/rendering/duration.js";
import { hydrateFromClassicTranscript, serializeForHistory } from "../../src/ui-core/state/transcript-hydrate.js";
import { applyAppEvent } from "../../src/ui-core/state/transcript/apply-app-event.js";
import { EMPTY_TRANSCRIPT_STATE, transcriptItems } from "../../src/ui-core/state/transcript-types.js";

const outcome = createTurnOutcome({ status: "succeeded", answer: "done", steps: 2, remainingCriteria: [] });
const ended: AgentEvent = { type: "turn-end", finalAnswer: "done", steps: 2, outcome };

function harness() {
  let now = 0;
  const events: AnyAppEvent[] = [];
  const seq = new EventSequencer(asSessionId("generation"), createCountingIdFactory(), { now: () => now });
  const adapter = new AgentEventAdapter(seq, new OutputSpool(), (event) => events.push(event));
  adapter.setTurn(asTurnId("first"));
  const state = () => events.reduce(applyAppEvent, EMPTY_TRANSCRIPT_STATE);
  return { adapter, events, state, advance(ms: number) { now += ms; } };
}

describe("turn generation summaries", () => {
  it.each([ended, { type: "turn-aborted" }, { type: "turn-error", message: "failed" }] satisfies AgentEvent[])("projects complete generation metrics for $type", (terminal) => {
    const h = harness();
    h.adapter.ingest({ type: "turn-start", prompt: "do work" });
    h.adapter.ingest({ type: "generation-progress", metrics: { outputTokens: 40, durationMs: 1_000, estimated: true } });
    h.adapter.ingest({ type: "generation-progress", metrics: { outputTokens: 80, durationMs: 1_800 } });
    h.adapter.ingest({ type: "generation-completed", metrics: { outputTokens: 100, durationMs: 2_000 } });
    h.advance(60_000);
    h.adapter.ingest({ type: "tool-call", id: "read", name: "fs.read", argsDisplay: "file.ts" });
    h.advance(12_000);
    h.adapter.ingest({ type: "tool-result", id: "read", ok: true, summary: "read" });
    h.adapter.ingest({ type: "token-usage", auxiliary: true, usage: { promptTokens: 1_000, completionTokens: 10_000, totalTokens: 11_000, exact: true } });
    h.adapter.ingest({ type: "generation-completed", metrics: { outputTokens: 300, durationMs: 10_000 } });
    h.adapter.ingest(terminal);
    const summary = transcriptItems(h.state()).find((item) => item.kind === "turn-summary");
    expect(summary).toMatchObject({ durationMs: 72_000, generation: { outputTokens: 400, durationMs: 12_000 } });
    expect(tokensPerSecondLabel(summary?.generation)).toBe("33.3 tok/s");
    expect(h.events.every((event, index) => event.sequence === index + 1)).toBe(true);
  });

  it("omits incomplete metrics and resets them for the next turn", () => {
    const h = harness();
    h.adapter.ingest({ type: "turn-start", prompt: "first" });
    h.adapter.ingest({ type: "generation-completed", metrics: { outputTokens: 100, durationMs: 2_000 } });
    h.adapter.ingest({ type: "generation-completed" });
    h.adapter.ingest({ type: "generation-completed", metrics: { outputTokens: 300, durationMs: 10_000 } });
    h.adapter.ingest(ended);
    h.adapter.setTurn(asTurnId("second"));
    h.adapter.ingest({ type: "turn-start", prompt: "second" });
    h.adapter.ingest({ type: "generation-completed", metrics: { outputTokens: 50, durationMs: 1_000 } });
    h.adapter.ingest(ended);
    h.adapter.setTurn(asTurnId("legacy"));
    h.adapter.ingest({ type: "turn-start", prompt: "legacy" });
    h.adapter.ingest(ended);
    const summaries = transcriptItems(h.state()).filter((item) => item.kind === "turn-summary");
    expect(summaries.map((item) => item.generation)).toEqual([undefined, { outputTokens: 50, durationMs: 1_000 }, undefined]);
  });

  it("round-trips generation facts rather than a rounded rate through history", () => {
    const h = harness();
    h.adapter.ingest({ type: "turn-start", prompt: "answer" });
    h.adapter.ingest({ type: "generation-completed", metrics: { outputTokens: 123, durationMs: 4_567.89 } });
    h.advance(76_000);
    h.adapter.ingest(ended);
    const saved = serializeForHistory(h.state(), () => "");
    const hydrated = hydrateFromClassicTranscript(saved).state;
    const summary = transcriptItems(hydrated).find((item) => item.kind === "turn-summary");
    expect(summary?.generation).toEqual({ outputTokens: 123, durationMs: 4_567.89 });
    expect(tokensPerSecondLabel(summary?.generation)).toBe("26.9 tok/s");
    expect(serializeForHistory(hydrated, () => "")).toEqual(saved);
  });

  it.each([
    undefined, { outputTokens: 1, durationMs: 0 }, { outputTokens: NaN, durationMs: 1 },
    { outputTokens: -1, durationMs: 1 }, { outputTokens: 1, durationMs: Infinity },
  ])("loads old or invalid history without inventing a rate: %j", (generation) => {
    const saved: TranscriptItem = { kind: "turn-summary", id: "old", durationMs: 76_000, status: "completed", generation, done: true };
    const summary = hydrateFromClassicTranscript([saved]).state.byId.get("old");
    expect(summary).toMatchObject({ durationMs: 76_000, status: "completed" });
    expect(summary?.kind === "turn-summary" && summary.generation).toBeUndefined();
  });
});
