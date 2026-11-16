import assert from "node:assert/strict";
import { act, createElement } from "react";
import { RGBA } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

const services = createCompositionRoot({
  noHistory: true,
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 32 }),
});
const theme = themeFor(services.capabilities.themeHint);
const lines = Array.from({ length: 120 }, (_, index) => {
  if (index === 90) return `${"wide ".repeat(32)}Target_90 tail`;
  if (index === 7) return "row 7 has target_7 and target_7b";
  return index % 20 === 7 ? `row ${index} has target_${index}` : `row ${index} filler`;
});

const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 100, height: 32, useThread: false, kittyKeyboard: false,
});

async function settle(action: () => unknown = () => undefined): Promise<string> {
  await act(async () => { await action(); });
  for (let frame = 0; frame < 4; frame += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 8)); });
    await act(async () => { await setup.renderOnce(); });
  }
  return setup.captureCharFrame();
}

const send = (data: string): Promise<string> => settle(() => setup.renderer.stdin.emit("data", Buffer.from(data)));

async function waitFor(text: string): Promise<string> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const frame = await settle();
    if (frame.includes(text)) return frame;
  }
  throw new Error(`Missing ${text}:\n${setup.captureCharFrame()}`);
}

function highlighted(color: string): string[] {
  const expected = RGBA.fromHex(color).toInts();
  return setup.captureSpans().lines.flatMap((line) => {
    const text = line.spans.map((span) => span.text).join("");
    return line.spans
      .filter((span) => span.bg.toInts().every((value, index) => value === expected[index]))
      .map((span) => `${span.text}@${text.trim()}`);
  });
}

function assertActive(marker: string): void {
  const active = highlighted(theme.searchActive);
  assert.equal(active.length, 1, `one active pager match: ${active.join(" | ")}\n${setup.captureCharFrame()}`);
  assert.match(active[0]!, /^target@/i, `only the matched text is highlighted: ${active[0]}`);
  assert.ok(active[0]!.includes(marker), `active match is ${marker}: ${active[0]}`);
}

try {
  await settle(() => services.overlay.openPager("Output", lines.join("\n"), undefined, undefined, "plain"));
  await waitFor("row 0 filler");
  await send("\x12");
  await settle(() => setup.mockInput.typeText("target"));
  await waitFor("1/8");
  assertActive("target_7");
  assert.ok(highlighted(theme.searchMatch).some((entry) => entry.includes("target_7b")), "other visible matches are highlighted");

  await send("\x1b[B");
  await waitFor("2/8");
  assertActive("target_7b");
  await send("\x1b[B");
  await waitFor("3/8");
  assertActive("target_27");
  await send("\x1b[A");
  await waitFor("2/8");

  await send("\x12");
  await waitFor("1/8");
  await send("\x12");
  await waitFor("8/8");
  assertActive("row 107");
  await send("\x1b[A");
  await waitFor("7/8");
  assertActive("Target_90");

  await send("\r");
  await waitFor("find:target 7/8");
  await send("n");
  await waitFor("find:target 8/8");
  await send("n");
  await waitFor("find:target 1/8");
  assertActive("target_7");
  await send("N");
  await waitFor("find:target 8/8");

  await send("\x1b");
  let frame = await settle();
  assert.ok(!frame.includes("find:target"), "Escape clears the pager search first");
  assert.equal(services.overlay.getState().kind, "pager", "the pager stays open after clearing a committed search");

  await send("\x12");
  await settle(() => setup.mockInput.typeText("filler"));
  await waitFor("/113");
  await send("\x1b");
  frame = await settle();
  assert.ok(!frame.includes("type to search"), "Escape leaves the pager search editor");
  assert.equal(services.overlay.getState().kind, "pager", "the pager stays open while a search is cleared");
  assert.equal(highlighted(theme.searchActive).length + highlighted(theme.searchMatch).length, 0);
  await send("\x1b");
  frame = await settle();
  assert.equal(services.overlay.getState().kind, "none", frame);
} finally {
  await act(async () => {
    services.dispose();
    setup.renderer.destroy();
  });
}
console.log("Native pager search passed");
