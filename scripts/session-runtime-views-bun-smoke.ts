import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppServices } from "../src/ui-core/bootstrap/composition-root.js";
import type { RuntimeViewTerminal } from "../src/session-runtime/view-terminal.js";
import type { RuntimeViewRenderer } from "../src/session-runtime/view-manager.js";
import type { RuntimeTerminalOptions } from "../src/session-runtime/types.js";

const sandbox = await mkdtemp(join(tmpdir(), "clai-native-views-"));
for (const key of ["CLAI_CONFIG_DIR", "CLAI_DATA_DIR", "CLAI_HISTORY_DIR", "CLAI_PLAN_DIR", "CLAI_LOG_DIR", "CLAI_ARTIFACT_DIR", "CLAI_JOBS_DIR", "CLAI_MCP_HOME", "CLAI_SESSION_WORKSPACE_DIR", "CLAI_SESSION_MODEL_DIR"]) {
  process.env[key] = join(sandbox, key);
}
process.env.CLAI_NO_UPDATE_CHECK = "1";
process.env.CLAI_NO_BROWSER = "1";
process.env.CLAI_DISABLE_KEYCHAIN = "1";
globalThis.fetch = async () => { throw new Error("Network is disabled in the native terminal view smoke"); };

const { createCompositionRoot } = await import("../src/ui-core/bootstrap/composition-root.js");
const { RuntimeViewManager } = await import("../src/session-runtime/view-manager.js");
const { createTurnOutcome } = await import("../src/agent/turn-outcome.js");
const { mountClassicRuntimeView } = await import("../src/classic/bootstrap/runtime-view.js");
const { mountOpenTuiRuntimeView } = await import("../src/tui-v2/bootstrap/runtime-view.js");
const output = new Map<string, string>();
const mounted: Array<{ terminal: RuntimeViewTerminal; services: AppServices; renderer: RuntimeViewRenderer }> = [];
let releaseTurn = (): void => {};
const finishTurn = new Promise<void>((resolve) => { releaseTurn = resolve; });
let requests = 0;
const saved: unknown[] = [];
const manager = new RuntimeViewManager({
  writeView(id, bytes) { output.set(id, (output.get(id) ?? "") + Buffer.from(bytes).toString("utf8")); return true; },
  closeView() { return true; }, minimise() { return true; }, switchSession() { return true; },
}, async (services, terminal, options) => {
  const renderer = options.ui === "tui" ? await mountOpenTuiRuntimeView(services, terminal, options.env) : await mountClassicRuntimeView(services, terminal, options.env);
  mounted.push({ services, terminal, renderer });
  return renderer;
});
const shared = createCompositionRoot({
  provider: "ollama", model: "fixture", confirm: manager.confirm, requestSecret: manager.requestSecret,
  agent: { async runTurn(request, handlers) {
    requests += 1;
    assert.equal(request.prompt, "SHARED_PROMPT_FROM_DESKTOP");
    handlers.onEvent({ type: "assistant-delta", text: "SHARED_STREAM_STARTED " });
    await finishTurn;
    assert.equal(handlers.signal?.aborted, false);
    handlers.onEvent({ type: "assistant-delta", text: "SHARED_STREAM_DONE" });
    handlers.onMessages?.([...(request.history ?? []), { role: "user", content: request.prompt }, { role: "assistant", content: "SHARED_STREAM_STARTED SHARED_STREAM_DONE" }]);
    return createTurnOutcome({ status: "succeeded", answer: "SHARED_STREAM_STARTED SHARED_STREAM_DONE", steps: 0, remainingCriteria: [] });
  } },
  persistence: {
    async saveSession(messages, options) { saved.push({ messages, ...options }); }, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {},
  },
});
manager.bind(shared);

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`native terminal views timed out: ${label}`);
}

function text(id: string): string {
  return (output.get(id) ?? "").replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?><:]*[ -/]*[@-~]/g, "");
}

function attach(id: string, ui: RuntimeTerminalOptions["ui"], columns: number, rows: number): void {
  manager.receive({ type: "view-attach", clientId: id, columns, rows, terminal: { ui, env: { TERM: "xterm-256color", CLAI_CLASSIC_MOUSE: "1" } } });
}

function input(id: string, bytes: string): void {
  manager.receive({ type: "view-input", clientId: id, data: Buffer.from(bytes).toString("base64") });
}

try {
  attach("desktop", "tui", 120, 36);
  attach("phone", "classic", 38, 20);
  attach("tablet", "tui", 70, 24);
  await waitFor(() => mounted.length === 3, "three independent renderers");
  for (const id of ["desktop", "phone", "tablet"]) await waitFor(() => text(id).includes("fixture"), `${id} first paint`);
  input("desktop", "\x1b[200~DESKTOP_PRIVATE_DRAFT\x1b[201~");
  input("phone", "\x1b[200~PHONE_PRIVATE_DRAFT\x1b[201~");
  input("tablet", "\x1b[200~TABLET_PRIVATE_DRAFT\x1b[201~");
  await waitFor(() => text("desktop").includes("DESKTOP_PRIVATE_DRAFT") && text("phone").includes("PHONE_PRIVATE_DRAFT") && text("tablet").includes("TABLET_PRIVATE_DRAFT"), "private composers");
  for (const id of ["desktop", "phone", "tablet"]) {
    for (const other of ["desktop", "phone", "tablet"]) if (id !== other) assert.ok(!text(id).includes(`${other.toUpperCase()}_PRIVATE_DRAFT`));
  }
  const desktop = mounted.find((view) => view.terminal.stdout.columns === 120)!;
  const tablet = mounted.find((view) => view.terminal.stdout.columns === 70)!;
  manager.receive({ type: "view-resize", clientId: "phone", columns: 28, rows: 16 });
  assert.deepEqual(desktop.terminal.stdout.getWindowSize(), [120, 36]);
  assert.deepEqual(tablet.terminal.stdout.getWindowSize(), [70, 24]);
  desktop.services.overlay.openPager("Desktop private pager", "DESKTOP_PRIVATE_PANEL");
  assert.ok(mounted.filter((view) => view !== desktop).every((view) => !view.services.overlay.isOpen()));
  desktop.services.overlay.close();
  input("desktop", "\x7f".repeat("DESKTOP_PRIVATE_DRAFT".length));
  await new Promise((resolve) => setTimeout(resolve, 80));
  input("desktop", "\x1b[200~SHARED_PROMPT_FROM_DESKTOP\x1b[201~");
  await new Promise((resolve) => setTimeout(resolve, 80));
  input("desktop", "\r");
  await waitFor(() => requests === 1 && shared.session.getState().running, "one shared turn");
  for (const id of ["desktop", "phone", "tablet"]) await waitFor(() => text(id).includes("SHARED_STREAM_STARTED"), `${id} receives stream`);
  assert.ok(mounted.every((view) => view.services.transcript.getState().byId === shared.transcript.getState().byId));
  await Promise.all(["desktop", "phone", "tablet"].map((id) => manager.detach(id)));
  assert.equal(shared.session.getState().running, true);
  attach("reattached-phone", "classic", 30, 18);
  await waitFor(() => text("reattached-phone").includes("SHARED_STREAM_STARTED"), "reattach preserves ongoing answer");
  releaseTurn();
  await waitFor(() => !shared.session.getState().running && text("reattached-phone").includes("SHARED_STREAM_DONE"), "shared turn settles after detach");
  await shared.session.persistNow();
  assert.equal(requests, 1);
  const persisted = JSON.stringify(saved.at(-1));
  assert.ok(persisted.includes("SHARED_STREAM_STARTED") && persisted.includes("SHARED_STREAM_DONE"));
  assert.ok(!persisted.includes("PRIVATE_DRAFT"));
  console.log("[PASS] Independent native views: two OpenTUI renderers and narrow Classic, private drafts and panels, isolated resize, one agent, durable detach and complete transcript");
} finally {
  releaseTurn();
  await manager.dispose();
  await shared.mcp.closeAll();
  shared.dispose();
  await rm(sandbox, { recursive: true, force: true });
}
