import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { TextareaRenderable, type Renderable } from "@opentui/core";

const root = await mkdtemp(join(tmpdir(), "clai-creds-native-"));
const keys = ["CLAI_DATA_DIR", "CLAI_CONFIG_DIR", "CLAI_HISTORY_DIR", "CLAI_LOG_DIR", "CLAI_PLAN_DIR", "CLAI_JOBS_DIR", "CLAI_ARTIFACT_DIR"];
const previous = keys.map((key) => process.env[key]);
for (const key of keys) process.env[key] = join(root, key);
process.env.CLAI_DISABLE_KEYCHAIN = "1";
const { createCompositionRoot } = await import("../../src/ui-core/bootstrap/composition-root.js");
const { detectCapabilities } = await import("../../src/ui-core/bootstrap/capabilities.js");
const { attachCommandHandlers } = await import("../../src/ui-core/commands/command-handlers.js");
const { ServicesProvider } = await import("../../src/ui-core/react/providers.js");
const { App } = await import("../../src/tui-v2/app/App.js");
const { getCredential, listCredentials } = await import("../../src/store/credentials.js");
const services = createCompositionRoot({
  noHistory: true, provider: "ollama", model: "fixture",
  updates: { async check() { return { state: "current", currentVersion: "0.0.0", updateAvailable: false }; } },
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 35 }),
});
attachCommandHandlers(services);
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width: 100, height: 35, kittyKeyboard: true, useThread: false });
async function settle(action: () => unknown = () => undefined): Promise<void> {
  await act(async () => { await action(); await new Promise((resolve) => setTimeout(resolve, 25)); });
  await act(async () => { await setup.flush(); });
}
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await settle();
  }
  throw new Error(`Native credential UI did not settle: ${setup.captureCharFrame()}`);
}
const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)];
function editor(): TextareaRenderable {
  const editors = descendants(setup.renderer.root).filter((node): node is TextareaRenderable => node instanceof TextareaRenderable);
  const found = editors.at(-1);
  assert.ok(found);
  return found;
}
try {
  await settle(() => services.commands.dispatch({ name: "creds" }));
  assert.match(setup.captureCharFrame(), /Machine sudo password/);
  await settle(() => setup.mockInput.pressEnter());
  await until(() => setup.captureCharFrame().includes("Credential title"));
  await settle(() => setup.mockInput.typeText("Native cloud login"));
  await settle(() => setup.mockInput.pressKey("s", { ctrl: true }));
  await until(() => setup.captureCharFrame().includes("Freeform private text"));
  assert.equal(editor().plainText, "", "title text must not carry into the credential body");
  const content = "username: deploy\npassword: native-secret-fixture\n\tSSH configuration\n";
  await settle(() => setup.mockInput.pasteBracketedText(content));
  assert.equal(editor().plainText, content);
  await settle(() => setup.mockInput.pressKey("s", { ctrl: true }));
  await until(async () => (await listCredentials()).length === 1);
  const entry = (await listCredentials())[0]!;
  assert.equal((await getCredential(entry.id))?.content, content);
  await settle(() => services.commands.dispatch({ name: "creds" }));
  assert.ok(!setup.captureCharFrame().includes("native-secret-fixture"));
  await settle(() => services.overlay.close());
  await settle(() => services.commands.dispatch({ name: "creds" }));
  await settle(() => services.overlay.selectPicker(entry.id));
  await settle(() => services.overlay.selectPicker("edit"));
  await until(() => setup.captureCharFrame().includes("Freeform private text"));
  assert.equal(editor().plainText, content);
  await settle(() => setup.mockInput.pressKey("\x1b"));
  assert.equal((await getCredential(entry.id))?.content, content);
  console.log("[PASS] Native /creds: title/body isolation, multiline tabs, encrypted reload, edit cancellation, and hidden picker content");
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
  for (const [index, key] of keys.entries()) {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }
  await rm(root, { recursive: true, force: true });
}
