import assert from "node:assert/strict";
import { act, createElement } from "react";
import { RGBA, TextareaRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { App } from "../../src/tui-v2/app/App.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { EventSequencer, createCountingIdFactory } from "../../src/app/events/sequencer.js";
import { asMessageId, asSessionId, asTurnId } from "../../src/app/events/app-event.js";

const services = createCompositionRoot({
  noHistory: true,
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 32 }),
});
const theme = themeFor(services.capabilities.themeHint);
const seq = new EventSequencer(asSessionId("search-native"), createCountingIdFactory("search"));
const total = 120;
for (let index = 0; index < total; index += 1) {
  const turn = asTurnId(`turn-${index}`);
  if (index === 30) {
    services.transcript.dispatch(seq.build("turn-started", { prompt: "please find the Needle in prompt thirty" }, turn));
    continue;
  }
  const text = index === 10
    ? "alpha NEEDLE_10 omega"
    : index === 60
      ? "first NEEDLE_60A then\nsecond NEEDLE_60B done"
      : index === 115
        ? "latest NEEDLE_115 here"
        : `filler message ${index}`;
  services.transcript.dispatch(seq.build("assistant-message", { messageId: asMessageId(`message-${index}`), text: `${text}\nEND_${index}` }, turn));
}

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

function bgOf(color: string): readonly number[] {
  return RGBA.fromHex(color).toInts();
}

function highlighted(color: string): string[] {
  const expected = bgOf(color);
  return setup.captureSpans().lines.flatMap((line) => {
    const text = line.spans.map((span) => span.text).join("");
    return line.spans
      .filter((span) => span.bg.toInts().every((value, index) => value === expected[index]))
      .map((span) => `${span.text.trim()}@${text.trim()}`);
  });
}

function assertActive(marker: string): void {
  const active = highlighted(theme.searchActive);
  assert.equal(active.length, 1, `exactly one active match is highlighted: ${active.join(" | ")}\n${setup.captureCharFrame()}`);
  assert.match(active[0]!, /^needle@/i, `the active highlight covers the matched text: ${active[0]}`);
  assert.ok(active[0]!.includes(marker), `the active match is ${marker}: ${active[0]}`);
}

function editor(): TextareaRenderable {
  const pending: Renderable[] = [setup.renderer.root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node instanceof TextareaRenderable) return node;
    pending.push(...node.getChildren());
  }
  throw new Error("Composer textarea is missing");
}

try {
  await waitFor(`END_${total - 1}`);
  assert.equal(services.focus.activeContext(), "composer", "Ctrl+R starts from the composer");

  await send("\x12");
  await waitFor("^R find");
  assert.equal(services.focus.activeContext(), "transcript-search");
  await settle(() => setup.mockInput.typeText("needle"));
  let frame = await waitFor("5/5");
  assert.ok(frame.includes("NEEDLE_115"), `typing starts from the newest match\n${frame}`);
  assertActive("NEEDLE_115");
  assert.equal(editor().plainText, "", "search typing never reaches the composer");

  await send("\x1b[A");
  frame = await waitFor("4/5");
  assertActive("NEEDLE_60B");
  assert.ok(highlighted(theme.searchMatch).some((entry) => entry.includes("NEEDLE_60A")), "other visible matches stay highlighted");

  await send("\x1b[A");
  await waitFor("3/5");
  assertActive("NEEDLE_60A");

  await send("\x12");
  frame = await waitFor("2/5");
  assert.ok(frame.includes("prompt thirty"), "Ctrl+R reveals matches in prompts outside the mounted window");
  assertActive("prompt thirty");

  await send("\x1b[A");
  await waitFor("1/5");
  assertActive("NEEDLE_10");

  await send("\x1b[A");
  await waitFor("5/5");
  assertActive("NEEDLE_115");

  await send("\x1b[B");
  await waitFor("1/5");
  assertActive("NEEDLE_10");

  await send("\r");
  frame = await waitFor(" find ");
  assert.ok(!frame.includes("^R find"), "Enter leaves the editor");
  assert.equal(services.focus.activeContext(), "transcript");

  await send("n");
  await waitFor("2/5");
  assertActive("prompt thirty");
  await send("N");
  await waitFor("1/5");
  assertActive("NEEDLE_10");

  await settle(() => services.focus.focusRegion("composer"));
  await send("n");
  frame = await settle();
  assert.ok(frame.includes("1/5"), "typing in the composer does not move the search");
  assert.equal(editor().plainText, "n");
  await send("\x11");

  await send("\x12");
  await waitFor("^R find");
  await send("\x1b");
  frame = await settle();
  assert.ok(!frame.includes(" find "), "Escape closes and clears the search");
  assert.equal(highlighted(theme.searchMatch).length + highlighted(theme.searchActive).length, 0, "highlights disappear with the search");
  assert.equal(services.focus.activeContext(), "composer");

  await settle(() => services.focus.focusRegion("transcript"));
  await send("n");
  assert.equal(editor().plainText, "n", "without an active search, typing from the transcript reaches the composer");
  await send("\x11");

  await send("\x12");
  await settle(() => setup.mockInput.typeText("zzzz"));
  await waitFor("no matches");
  await send("\x1b");
} finally {
  await act(async () => {
    services.dispose();
    setup.renderer.destroy();
  });
}
console.log("Native transcript search passed");
