import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { EMPTY_TRANSCRIPT_STATE, type AssistantItem } from "../../src/ui-core/state/transcript-types.js";
import { TerminalSgrCompactor } from "../../src/os/terminal-sgr-compactor.js";
import { RuntimeViewTerminal } from "../../src/session-runtime/view-terminal.js";
import { mountClassicRuntimeView } from "../../src/classic/bootstrap/runtime-view.js";
import { mountOpenTuiRuntimeView } from "../../src/tui-v2/bootstrap/runtime-view.js";

process.env.CLAI_NO_UPDATE_CHECK = "1";
process.env.CLAI_DISABLE_KEYCHAIN = "1";
globalThis.fetch = async () => { throw new Error("Scroll output test is offline"); };

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 8000;
  while (!check()) {
    assert.ok(performance.now() < deadline, "renderer did not settle");
    await delay(10);
  }
}

async function exercise(ui: "tui" | "classic"): Promise<void> {
  const raw: Buffer[] = [];
  const wire: Buffer[] = [];
  const trace: Array<{ at: number; raw: number; wire: number }> = [];
  const compactor = new TerminalSgrCompactor();
  const terminal = new RuntimeViewTerminal({ columns: 120, rows: 40 }, (bytes) => {
    const compacted = Buffer.from(compactor.compact(bytes));
    raw.push(Buffer.from(bytes));
    wire.push(compacted);
    trace.push({ at: performance.now(), raw: bytes.byteLength, wire: compacted.byteLength });
    return true;
  });
  const services = createCompositionRoot({
    noHistory: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor", TERM: "xterm-256color" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 120, rows: 40 }),
    updates: { async check() { return { state: "current", currentVersion: "test", updateAvailable: false }; } },
  });
  const items: AssistantItem[] = Array.from({ length: 100 }, (_, index) => ({
    id: `output-${index}`, kind: "assistant", sequence: index + 1, timestamp: 0, turnId: undefined, streaming: false,
    text: Array.from({ length: 12 }, (_, line) => `ITEM_${String(index).padStart(3, "0")}_ROW_${line} **retained** 日本語 🧪 ${"abcdefghijk".slice(line % 7)}`).join("\n"),
  }));
  services.transcript.hydrate({ ...EMPTY_TRANSCRIPT_STATE, order: items.map((item) => item.id), byId: new Map(items.map((item) => [item.id, item])) });
  const original = services.transcript.getState();
  const mount = ui === "tui" ? mountOpenTuiRuntimeView : mountClassicRuntimeView;
  const renderer = await mount(services, terminal, { TERM: "xterm-256color", COLORTERM: "truecolor", CLAI_CLASSIC_MOUSE: "1" });
  const text = (): string => Buffer.concat(raw).toString().replace(/\x1b\[[\d;?]*[ -/]*[@-~]/g, "");
  try {
    await waitFor(() => text().includes("ITEM_099"));
    await delay(100);
    const firstTrace = trace.length;
    const startedAt = performance.now();
    for (const direction of [64, 65]) {
      for (let report = 0; report < 60; report += 1) {
        terminal.stdin.write(`\x1b[<${direction};10;8M`);
        await delay(4);
      }
      for (let burst = 0; burst < 10; burst += 1) {
        terminal.stdin.write(`\x1b[<${direction};10;8M`.repeat(6));
        await delay(24);
      }
      await delay(100);
    }
    const inputEndedAt = performance.now();
    await delay(100);
    assert.equal(services.transcript.getState().order, original.order);
    assert.equal(services.transcript.getState().byId, original.byId);
    assert.equal(original.order.length, 100);
    const scrollTrace = trace.slice(firstTrace);
    const rawBytes = scrollTrace.reduce((sum, frame) => sum + frame.raw, 0);
    const wireBytes = scrollTrace.reduce((sum, frame) => sum + frame.wire, 0);
    assert.ok(rawBytes > 1000, "wheel input must produce real terminal output");
    assert.ok(wireBytes <= rawBytes, "compaction must not increase terminal traffic");
    if (ui === "tui") assert.ok(wireBytes < rawBytes * 0.8, "redundant native styles must be compacted");
    terminal.stdin.write("\x1b[200~retained draft 日本語 🧪\x1b[201~");
    await waitFor(() => text().includes("retained draft"));
    terminal.resize({ columns: 80, rows: 28 });
    await delay(220);
    terminal.resize({ columns: 120, rows: 40 });
    await delay(150);
    assert.equal(services.transcript.getState().byId, original.byId);
    const linkLag = (field: "raw" | "wire"): number => {
      let finishedAt = startedAt;
      for (const frame of scrollTrace) finishedAt = Math.max(frame.at, finishedAt) + frame[field] / 100;
      return Math.round(Math.max(0, finishedAt - inputEndedAt));
    };
    console.log(JSON.stringify({ ui, reports: 240, rawBytes, wireBytes, savedPercent: Math.round(100 * (1 - wireBytes / rawBytes)), modeled100KBpsLagMs: { raw: linkLag("raw"), wire: linkLag("wire") } }));
  } finally {
    await renderer.dispose();
    wire.push(Buffer.from(compactor.finish()));
    services.dispose();
    terminal.dispose();
    const outputDir = process.env.CLAI_SCROLL_OUTPUT_DIR;
    if (outputDir) {
      writeFileSync(join(outputDir, `${ui}-raw.ansi`), Buffer.concat(raw));
      writeFileSync(join(outputDir, `${ui}-wire.ansi`), Buffer.concat(wire));
    }
  }
}

await exercise("tui");
await exercise("classic");
console.log("[PASS] Scroll output: both real renderers, bursty input, retained transcript, composer and resize");
