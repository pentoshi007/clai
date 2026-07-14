// Phase 1 spike runner (V2-011..V2-014). Run with: bun run scripts/v2-spikes/run-all.ts
//
// Exits non-zero if any spike fails, so it can gate Phase 1. The pane-selection
// spike's result is interpreted in ADR-005 regardless of pass/fail.
import { printResult, type SpikeResult } from "./harness.js";
import { runStreamingMarkdownSpike } from "./streaming-markdown.spike.js";
import { runViewportCullingSpike } from "./viewport-culling.spike.js";
import { runPaneSelectionSpike } from "./pane-selection.spike.js";
import { runShellRenderSpike } from "./shell-render.spike.js";
import { runComposerSpike } from "./composer.spike.js";

const spikes: Array<() => Promise<SpikeResult>> = [
  runViewportCullingSpike,
  runStreamingMarkdownSpike,
  runShellRenderSpike,
  runComposerSpike,
  runPaneSelectionSpike,
];

const results: SpikeResult[] = [];
for (const spike of spikes) {
  try {
    const r = await spike();
    results.push(r);
    printResult(r);
  } catch (err) {
    console.log(`\n[ERROR] spike threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    results.push({
      id: spike.name,
      title: "(threw)",
      passed: false,
      checks: [{ label: "spike executed without throwing", ok: false }],
      measurements: {},
      notes: [],
    });
  }
}

const passed = results.filter((r) => r.passed).length;
console.log(`\n==== Spike summary: ${passed}/${results.length} passed ====`);
for (const r of results) {
  console.log(`  ${r.passed ? "PASS" : "FAIL"}  ${r.id} — ${r.title}`);
}
process.exit(results.every((r) => r.passed) ? 0 : 1);
