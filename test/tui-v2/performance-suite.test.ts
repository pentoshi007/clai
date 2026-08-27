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
import { computeLayout } from "../../src/ui-core/layout/compute-layout.js";
import { presentOutput } from "../../src/ui-core/rendering/tool-presenter.js";
import { extractTranscriptSemanticDocument } from "../../src/ui-core/rendering/transcript-semantic.js";
import { applyAppEvent } from "../../src/ui-core/state/transcript-reducer.js";
import { TranscriptStore } from "../../src/ui-core/state/transcript-store.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type TranscriptState,
} from "../../src/ui-core/state/transcript-types.js";

const TEN_K = 10_000;
// Generous CI budgets — fail only pathological O(n²) regressions.
const FOLD_BUDGET_MS = 2_000;
const LAYOUT_STORM_BUDGET_MS = 250;
const SEMANTIC_BUDGET_MS = 1_500;
const STORE_BURST_BUDGET_MS = 2_000;

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

  it("uses finite production spool and transcript retention defaults", () => {
    const spool = new OutputSpool();
    for (let tool = 0; tool < 140; tool += 1) {
      spool.replace(asToolCallId(`tool-${tool}`), "x".repeat(300 * 1024));
    }
    expect(spool.has(asToolCallId("tool-0"))).toBe(false);
    const latest = spool.state(asToolCallId("tool-139"))!;
    expect(latest.tail.length).toBeLessThanOrEqual(256 * 1024);
    expect(latest.truncated).toBe(true);

    const store = new TranscriptStore(100);
    const seq = sequencer();
    // Notices are toast-only and do not enter the store; use real conversation rows.
    for (let i = 0; i < 1_000; i += 1) {
      store.dispatch(
        seq.build(
          "assistant-message",
          { messageId: seq.ids.message(), text: `event-${i}` },
          undefined,
        ),
      );
    }
    const retained = store.getState();
    expect(retained.order.length).toBeGreaterThanOrEqual(90);
    expect(retained.order.length).toBeLessThanOrEqual(100);
    expect(retained.byId.size).toBe(retained.order.length);
  });

  it(`coalesces a near-cap token burst within ${STORE_BURST_BUDGET_MS}ms`, () => {
    const store = new TranscriptStore(2_000);
    const seq = sequencer();
    for (let index = 0; index < 2_000; index += 1) {
      store.dispatch(
        seq.build(
          "assistant-message",
          { messageId: seq.ids.message(), text: `seed-${index}` },
          undefined,
        ),
      );
    }

    const turnId = asTurnId("turn-burst");
    const chunks = 10_000;
    const t0 = performance.now();
    for (let index = 0; index < chunks; index += 1) {
      store.dispatch(seq.build("assistant-delta", { text: "x" }, turnId));
    }
    store.dispatch(
      seq.build(
        "assistant-message",
        { messageId: seq.ids.message(), text: "x".repeat(chunks) },
        turnId,
      ),
    );
    const ms = performance.now() - t0;
    const state = store.getState();
    const last = state.byId.get(state.order.at(-1)!);
    expect(last).toMatchObject({ kind: "assistant", text: "x".repeat(chunks) });
    expect(ms).toBeLessThan(STORE_BURST_BUDGET_MS);
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
    // Real conversation rows — UI notices are intentionally omitted from
    // semantic export (not model/selection context).
    const order: string[] = [];
    const byId = new Map();
    for (let i = 0; i < TEN_K; i++) {
      const id = `user-${i}`;
      order.push(id);
      byId.set(id, {
        id,
        sequence: i + 1,
        turnId: undefined,
        timestamp: i + 1,
        kind: "user",
        text: `user prompt ${i}`,
      });
    }
    const state: TranscriptState = {
      ...EMPTY_TRANSCRIPT_STATE,
      order,
      byId,
      lastSequence: TEN_K,
    };
    const t0 = performance.now();
    const doc = extractTranscriptSemanticDocument(state, { thinking: "none" });
    const ms = performance.now() - t0;
    expect(doc.blocks.length).toBe(TEN_K);
    expect(ms).toBeLessThan(SEMANTIC_BUDGET_MS);
  });
});
