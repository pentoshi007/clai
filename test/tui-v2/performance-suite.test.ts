/**
 * V2-091 — Node-side performance budgets for pure app/tui-v2 paths.
 *
 * Native frame times live in Bun spikes (V2-013); this suite guards reducer
 * throughput, spool bounds, layout resize storms, and 10k-item semantic fold
 * under CI so regressions fail without a live terminal.
 */
import { describe, expect, it } from "vitest";
import {
  asSessionId,
  asToolCallId,
  asTurnId,
} from "../../src/app/events/app-event.js";
import { OutputSpool } from "../../src/app/events/event-buffer.js";
import { createCountingIdFactory, EventSequencer } from "../../src/app/events/sequencer.js";
import { computeLayout } from "../../src/tui-v2/layout/compute-layout.js";
import { presentOutput } from "../../src/tui-v2/rendering/tool-presenter.js";
import { extractTranscriptSemanticDocument } from "../../src/tui-v2/rendering/transcript-semantic.js";
import { applyAppEvent } from "../../src/tui-v2/state/transcript-reducer.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type TranscriptState,
} from "../../src/tui-v2/state/transcript-types.js";

const TEN_K = 10_000;
// Generous CI budgets — fail only pathological O(n²) regressions.
const FOLD_BUDGET_MS = 2_000;
const LAYOUT_STORM_BUDGET_MS = 250;
const SEMANTIC_BUDGET_MS = 1_500;

function sequencer() {
  return new EventSequencer(
    asSessionId("perf-sess"),
    createCountingIdFactory("perf-"),
    { now: () => 1_700_000_000_000 },
  );
}

describe("V2-091 performance suite (Node pure paths)", () => {
  it(`folds ${TEN_K} assistant-delta events within ${FOLD_BUDGET_MS}ms`, () => {
    const seq = sequencer();
    const turnId = asTurnId("turn-perf");
    let state: TranscriptState = EMPTY_TRANSCRIPT_STATE;
    const t0 = performance.now();
    for (let i = 0; i < TEN_K; i++) {
      state = applyAppEvent(
        state,
        seq.build("assistant-delta", { text: `t${i % 10}` }, turnId),
      );
    }
    state = applyAppEvent(
      state,
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "done" },
        turnId,
      ),
    );
    const ms = performance.now() - t0;
    expect(state.order).toHaveLength(1);
    expect(ms).toBeLessThan(FOLD_BUDGET_MS);
  });

  it("keeps OutputSpool memory bounded under a 10 MB stream", () => {
    const spool = new OutputSpool(20_000);
    const id = asToolCallId("huge");
    const chunk = "x".repeat(64 * 1024);
    const chunks = Math.ceil((10 * 1024 * 1024) / chunk.length);
    for (let i = 0; i < chunks; i++) spool.append(id, chunk);
    const snap = spool.state(id)!;
    expect(snap.tail.length).toBeLessThanOrEqual(20_000);
    expect(snap.truncated).toBe(true);
    expect(snap.totalBytes).toBeGreaterThanOrEqual(10 * 1024 * 1024);
    const presented = presentOutput(snap.tail, snap, false);
    expect(presented.lines.length).toBeLessThanOrEqual(4);
    expect(presented.truncatedNotice).toBeDefined();
  });

  it(`survives a resize storm within ${LAYOUT_STORM_BUDGET_MS}ms`, () => {
    const t0 = performance.now();
    for (let cols = 70; cols <= 180; cols += 2) {
      for (let rows = 20; rows <= 60; rows += 4) {
        const model = computeLayout({
          columns: cols,
          rows,
          planVisible: true,
          splitEnabled: true,
        });
        expect(model.columns).toBe(cols);
        expect(model.rows).toBe(rows);
        expect(model.chat.width).toBeGreaterThanOrEqual(0);
        expect(model.chat.height).toBeGreaterThanOrEqual(0);
        expect(model.composer.y + model.composer.height).toBe(rows);
      }
    }
    expect(performance.now() - t0).toBeLessThan(LAYOUT_STORM_BUDGET_MS);
  });

  it(`builds a ${TEN_K}-item semantic document within ${SEMANTIC_BUDGET_MS}ms`, () => {
    const seq = sequencer();
    let state: TranscriptState = EMPTY_TRANSCRIPT_STATE;
    for (let i = 0; i < TEN_K; i++) {
      state = applyAppEvent(
        state,
        seq.build("notice", { level: "info", text: `n-${i}` }, undefined),
      );
    }
    const t0 = performance.now();
    const doc = extractTranscriptSemanticDocument(state, { thinking: "none" });
    const ms = performance.now() - t0;
    expect(doc.blocks.length).toBe(TEN_K);
    expect(ms).toBeLessThan(SEMANTIC_BUDGET_MS);
  });
});
