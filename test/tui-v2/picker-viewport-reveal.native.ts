import assert from "node:assert/strict";
import { act, createElement } from "react";
import { ScrollBoxRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { layoutPickerOptions } from "../../src/ui-core/rendering/picker-layout.js";
import type { PickerOption } from "../../src/ui-core/rendering/picker-filter.js";

const ACTIVE = 50;
const services = createCompositionRoot({
  noHistory: true,
  provider: "openai",
  model: "test-model",
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 90, rows: 28 }),
});
const options: PickerOption[] = Array.from({ length: 200 }, (_, index) => ({
  value: `session-${index}`,
  label: `Session ${String(index).padStart(3, "0")}`,
  description: `id session-${index} · ${index} items${index % 3 === 2 ? "\nMore session details" : ""}`,
  active: index === ACTIVE,
}));
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 90, height: 28, kittyKeyboard: true, useMouse: true, useThread: false,
});
const idle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function picker(): ScrollBoxRenderable {
  const value = setup.renderer.root.findDescendantById("picker-options");
  assert.ok(value instanceof ScrollBoxRenderable);
  return value;
}
function selectedIndex(): number {
  const row = setup.captureCharFrame().split("\n").find((line) => line.includes("❯"));
  const label = row?.match(/Session (\d+)/);
  return label ? Number(label[1]) : -1;
}
try {
  await act(async () => { await setup.renderOnce(); });
  await act(async () => {
    services.overlay.openPicker({ title: "History", historyStyle: true, twoLine: true, options }, () => services.overlay.close());
    await idle(20);
  });
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => { await setup.renderOnce(); });
  }
  assertActiveVisible("initial layout");
  for (const [width, height] of [[90, 16], [60, 12], [90, 28]] as const) {
    await act(async () => { setup.resize(width, height); await idle(20); });
    for (let pass = 0; pass < 3; pass += 1) {
      await act(async () => { await setup.renderOnce(); });
    }
    assertActiveVisible(`picker viewport resized to ${width}x${height}`);
  }
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
}
console.log("Native picker viewport reveal passed");

function assertActiveVisible(context: string): void {
  const box = picker();
  const item = layoutPickerOptions(options, box.viewport.width, true)[ACTIVE]!;
  assert.equal(selectedIndex(), ACTIVE, `${context}: the active session must stay visible`);
  assert.ok(
    item.top >= box.scrollTop && item.top + item.height <= box.scrollTop + box.viewport.height,
    `${context}: the active session must be fully inside the picker viewport`,
  );
}
