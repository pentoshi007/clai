import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { createOsc52ClipboardPort } from "../../src/ui-core/ports/clipboard-osc52.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { formatAttachmentReference } from "../../src/ui/mentions.js";
import type { RunTurnRequest } from "../../src/app/ports/agent-port.js";

const directory = await mkdtemp(join(tmpdir(), "clai-native-attachments-"));
const path = join(directory, "original screenshot (1).png");
const pixels = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
await writeFile(path, pixels);
const reference = formatAttachmentReference(path);
let releaseClipboard!: (text: string) => void;
let reads = 0;
const requests: RunTurnRequest[] = [];
const dispatched = [Promise.withResolvers<RunTurnRequest>(), Promise.withResolvers<RunTurnRequest>()];
const completed = Promise.withResolvers<void>();
const services = createCompositionRoot({
  noHistory: true, provider: "openai", model: "gpt-4o",
  clipboard: createOsc52ClipboardPort({
    enabled: true,
    renderer: { isOsc52Supported: () => true, copyToClipboardOSC52: () => true },
    fallback: {
      async writeText() {},
      readText() {
        reads += 1;
        return new Promise<string>((resolve) => { releaseClipboard = resolve; });
      },
    },
  }),
  agent: {
    reportsModelSubmission: true,
    async runTurn(request, handlers) {
      requests.push(request);
      dispatched[requests.length - 1]?.resolve(request);
      handlers.onEvent({ type: "turn-start", prompt: request.prompt });
      handlers.onEvent({ type: "model-submitted" });
      if (requests.length === 1) {
        await new Promise<void>((_resolve, reject) => {
          handlers.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      return createTurnOutcome({ status: "succeeded", answer: "seen", steps: 1, remainingCriteria: [] });
    },
  },
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
});
const unsubscribe = services.session.onTurnEnd((result) => {
  if (requests.length === 2 && result.status === "completed") completed.resolve();
});
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 100, height: 30, useThread: false,
});
async function settle(action: () => unknown = () => undefined): Promise<void> {
  await act(async () => { await action(); await setup.flush(); });
}
try {
  await settle();
  await settle(() => setup.mockInput.pressKey("v", { ctrl: true }));
  assert.equal(reads, 1, "the actual UI preserves reads through the OSC 52 wrapper");
  await settle(() => setup.mockInput.typeText("typing"));
  assert.match(setup.captureCharFrame(), /typing/, "typing renders before clipboard completion");
  releaseClipboard(reference);
  await act(async () => { await setup.waitForFrame((frame) => frame.includes("[Image 1]")); });
  assert.doesNotMatch(setup.captureCharFrame(), /file:\/\//);
  await settle(() => setup.mockInput.pressEnter());
  await act(async () => {
    await dispatched[0]!.promise;
    await setup.flush();
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.prompt, `typing ${reference}`);
  assert.deepEqual(Buffer.from(requests[0]!.images![0]!.dataBase64, "base64"), pixels);
  await settle(() => setup.renderer.stdin.emit("data", Buffer.from(`\x1b[200~${reference}\x1b[201~`)));
  await act(async () => { await setup.waitForFrame((frame) => frame.includes("[Image 1]")); });
  await settle(() => setup.mockInput.pressEnter());
  assert.deepEqual(services.session.getState().queued, [reference]);
  assert.doesNotMatch(setup.captureCharFrame(), /file:\/\//);
  await settle(() => services.session.sendQueuedNow(0));
  await act(async () => {
    await dispatched[1]!.promise;
    await completed.promise;
    await setup.flush();
  });
  assert.equal(requests.length, 2);
  assert.equal(services.session.getState().running, false);
  assert.equal(requests[1]!.prompt, reference);
  assert.deepEqual(Buffer.from(requests[1]!.images![0]!.dataBase64, "base64"), pixels);
  assert.deepEqual(services.session.getState().queued, []);
  console.log("Native attachment flow passed: responsive clipboard typing, compact references, exact normal-send and queued send-now image bytes");
} catch (error) {
  console.error(JSON.stringify({ reads, requests: requests.length, running: services.session.getState().running, frame: setup.captureCharFrame() }));
  throw error;
} finally {
  unsubscribe();
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
  await rm(directory, { recursive: true, force: true });
}
