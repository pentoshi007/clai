import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { createInMemoryClipboardPort } from "../../src/app/adapters/in-memory-clipboard-adapter.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asMessageId, asSessionId, asTurnId } from "../../src/app/events/app-event.js";

const CODE = [
  "curl -fsSL https://example.com/some/really/long/path/to/install.sh?token=abc123&mode=full | bash -s -- --yes",
  "npm install --save-dev typescript @types/node vitest eslint prettier tsx",
].join("\n");

for (const width of [60, 100]) {
  const clipboard = createInMemoryClipboardPort();
  const services = createCompositionRoot({
    noHistory: true,
    clipboard,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 40 }),
  });
  const seq = new EventSequencer(asSessionId("code-copy-native"), createCountingIdFactory("code"));
  services.transcript.dispatch(seq.build("assistant-message", {
    messageId: asMessageId("message-code"),
    text: `Run this:\n\n\`\`\`bash\n${CODE}\n\`\`\`\n\nDONE_MARK`,
  }, asTurnId("code-turn")));
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width, height: 40, useThread: false, useMouse: true });
  const settle = async (action: () => unknown = () => undefined): Promise<void> => {
    await act(async () => { await action(); await setup.flush(); });
  };
  try {
    await settle();
    await act(async () => { await setup.waitForFrame((frame) => frame.includes("DONE_MARK")); });
    const frame = setup.captureCharFrame();
    const rows = frame.split("\n");
    const header = rows.findIndex((row) => row.includes("╭") && row.includes(" copy "));
    assert.ok(header >= 0, frame);
    assert.ok(rows.some((row) => row.includes("↪")), "long commands wrap with a continuation mark");
    const tab = rows[header]!.indexOf(" copy ") + 2;
    await settle(() => setup.mockMouse.click(tab, header));
    await act(async () => { await setup.waitFor(() => clipboard.lastText !== undefined); });
    assert.equal(clipboard.lastText, CODE, "the copy tab copies the exact block source");

    const bottom = rows.findIndex((row, index) => index > header && row.includes("╰"));
    const left = rows[header]!.indexOf("╭");
    const right = rows[bottom]!.indexOf("╯");
    await clipboard.writeText("");
    await settle(() => setup.mockMouse.drag(left, header + 1, right, bottom - 1));
    await act(async () => { await setup.waitFor(() => clipboard.lastText !== ""); });
    assert.equal(clipboard.lastText, CODE, "a drag selection over wrapped rows copies the source without frames");

    await clipboard.writeText("unchanged after cancellation");
    await settle(async () => {
      await setup.mockMouse.pressDown(left, header + 1);
      await setup.mockMouse.moveTo(right, bottom - 1);
    });
    assert.ok(setup.renderer.getSelection()?.isDragging);
    await settle(() => setup.mockInput.pressKey("\x1b[27u"));
    assert.equal(setup.renderer.hasSelection, false, "escape clears the native gesture before release");
    await settle(() => setup.mockMouse.release(right, bottom - 1));
    assert.equal(setup.renderer.hasSelection, false);
    assert.equal(clipboard.lastText, "unchanged after cancellation", "releasing an escaped gesture does not copy");
  } finally {
    await act(async () => {
      services.dispose();
      setup.renderer.destroy();
    });
    await setup.renderer.idle();
  }
}
console.log("Native code block copy passed: copy tab and framed drag selection at 60/100 columns");
