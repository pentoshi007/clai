import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildFeedBlocks, FeedBlockCache } from "../src/classic/feed/feed-blocks.js";
import { classicTranscriptDocument } from "../src/classic/feed/transcript-selection.js";
import { planTranscriptWindow } from "../src/classic/feed/transcript-window.js";
import { createInkTheme } from "../src/classic/render/ink-theme.js";
import { EMPTY_TRANSCRIPT_STATE, type AssistantItem } from "../src/ui-core/state/transcript-types.js";
import { TranscriptStore } from "../src/ui-core/state/transcript-store.js";
import { EventSequencer } from "../src/app/events/sequencer.js";
import { asSessionId, asTurnId } from "../src/app/events/app-event.js";
import { hydrateFromClassicTranscript, serializeForHistory } from "../src/ui-core/state/transcript-hydrate.js";
import { renderTranscriptSemanticText } from "../src/ui-core/rendering/transcript-semantic.js";

const count = Number(process.argv[2] ?? 1000);
assert.ok(Number.isSafeInteger(count) && count > 0);
const memory = () => {
  global.gc?.();
  const value = process.memoryUsage();
  return { heapMiB: value.heapUsed / 1048576, rssMiB: value.rss / 1048576 };
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const deferred = process.argv.includes("--lazy");
const view = { columns: 100, ink: createInkTheme({ themeHint: "dark", colorMode: "truecolor", unicode: true }), now: 0, generation: 0, deferLayout: deferred };

if (process.argv.includes("--soak")) {
  const store = new TranscriptStore();
  let tick = 0;
  const seq = new EventSequencer(asSessionId("resource-soak"), undefined, { now: () => tick });
  const samples = [];
  let compactions = 0;
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    tick += 15_000;
    const turn = asTurnId(`turn-${index}`);
    store.dispatch(seq.build("turn-started", { prompt: `PROMPT_${index} retained 日本語 🧪` }, turn));
    const text = Array.from({ length: 20 }, (_, row) => `RESPONSE_${index}_${row} complete 日本語 🧪 **bold** and details.`).join("\n");
    for (let offset = 0; offset < text.length; offset += 32) store.dispatch(seq.build("assistant-delta", { text: text.slice(offset, offset + 32) }, turn));
    store.dispatch(seq.build("assistant-message", { messageId: seq.ids.message(), text }, turn));
    if (index % 2 === 1) {
      store.dispatch(seq.build("compaction-completed", { compactionId: `compaction-${index}`, summary: `memory ${index}`, beforeTokens: 10000, afterTokens: 1000 }, turn));
      compactions += 1;
    }
    if ((index + 1) % 100 === 0) {
      const saved = serializeForHistory(store.getState(), () => "");
      samples.push({ turns: index + 1, items: saved.length, serializedBytes: Buffer.byteLength(JSON.stringify(saved)), ...memory() });
    }
  }
  const state = store.getState();
  assert.equal(state.order.length, count * 2 + compactions);
  const text = renderTranscriptSemanticText(state, { thinking: "all" });
  const saved = serializeForHistory(state, () => "");
  const restored = hydrateFromClassicTranscript(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored.state.order, state.order);
  assert.equal(digest(renderTranscriptSemanticText(restored.state, { thinking: "all" })), digest(text));
  for (const index of [0, Math.floor(count / 2), count - 1]) {
    assert.ok(text.includes(`PROMPT_${index} retained 日本語 🧪`));
    assert.ok(text.includes(`RESPONSE_${index}_19 complete 日本語 🧪 **bold** and details.`));
  }
  store.dispose();
  console.log(JSON.stringify({ workload: "accelerated-stream-compaction-soak", turns: count, compactions, simulatedHours: tick / 3600000, events: state.lastSequence, elapsedMs: performance.now() - started, transcriptSha256: digest(text), samples, ...memory() }, null, 2));
} else {
  const items: AssistantItem[] = Array.from({ length: count }, (_, index) => ({
    id: `assistant-${index}`, kind: "assistant", streaming: false, sequence: index, timestamp: 0, turnId: undefined,
    text: Array.from({ length: 100 }, (_, row) => `Item ${index} line ${row}: complete retained text 日本語 🧪 **bold** and \`code\` with details.`).join("\n"),
  }));
  const state = { ...EMPTY_TRANSCRIPT_STATE, order: items.map((item) => item.id), byId: new Map(items.map((item) => [item.id, item])) };
  const cache = new FeedBlockCache();
  const before = memory();
  const started = performance.now();
  const blocks = buildFeedBlocks(state, view, cache);
  const window = planTranscriptWindow(blocks, 30, 0);
  const document = classicTranscriptDocument(blocks);
  const buildMs = performance.now() - started;
  const retained = memory();
  const updateMs: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const start = performance.now();
    const next = buildFeedBlocks(state, { ...view, now: index }, cache);
    planTranscriptWindow(next, 30, index);
    classicTranscriptDocument(next);
    updateMs.push(performance.now() - start);
  }
  const first = planTranscriptWindow(blocks, 30, window.totalRows);
  assert.equal(first.firstItemId, "assistant-0");
  assert.equal(window.lastItemId, `assistant-${count - 1}`);
  if (!deferred) assert.equal(window.totalRows, count * 101 - 1);
  assert.equal(document.blocks.length, count);
  assert.ok(cache.retainedLayoutBytes <= 16 * 1024 * 1024);
  console.log(JSON.stringify({ workload: "classic-100-lines-per-message", count, sourceBytes: items.reduce((total, item) => total + Buffer.byteLength(item.text), 0), buildMs, before, retained, layoutBytes: cache.retainedLayoutBytes, totalRows: window.totalRows, mountedRows: window.rows.length, updateMs }, null, 2));
}
