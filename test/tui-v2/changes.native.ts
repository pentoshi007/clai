import assert from "node:assert/strict";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { spyOn } from "bun:test";
import { RGBA } from "@opentui/core";
import { App } from "../../src/tui-v2/app/App.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { hydrateFromClassicTranscript } from "../../src/ui-core/state/transcript-hydrate.js";
import { getProvider } from "../../src/llm/router.js";
import { diffedChangeTranscript, largeChangeTranscript, savedChanges, savedChangeTranscript } from "../fixtures/session-changes.js";
import { syntaxColor } from "../../src/ui-core/rendering/file-diff-view.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";

spyOn(getProvider("free"), "listModels").mockResolvedValue([]);
const requests = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Native changes fixture must not access the network"));
for (const width of [120, 80, 40]) {
  const services = createCompositionRoot({
    noHistory: true, provider: "free", model: "fixture-model",
    updates: { async check() { return { state: "current", currentVersion: "0.0.0", updateAvailable: false }; } },
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 35 }),
  });
  services.session.loadHistory([], { sessionId: `saved-change-${width}`, changes: savedChanges });
  services.transcript.hydrate(hydrateFromClassicTranscript(savedChangeTranscript).state);
  attachCommandHandlers(services);
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width, height: 35, kittyKeyboard: true, useThread: false });
  async function settle(action: () => unknown = () => undefined): Promise<string> {
    await act(async () => { await action(); });
    await act(async () => { await setup.flush(); });
    return setup.captureCharFrame().replace(/[│║]/g, "").replace(/\s+/g, " ");
  }
  async function waitFor(text: string): Promise<string> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const frame = await settle();
      if (frame.includes(text)) return frame;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`);
  }
  const theme = themeFor(services.capabilities.themeHint);
  function assertColor(text: string, color: string): void {
    const span = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(text));
    assert.ok(span, `Missing colored text: ${text}`);
    assert.deepEqual(span.fg.toInts(), RGBA.fromHex(color).toInts(), `Incorrect color for ${text}`);
  }
  try {
    const frame = await waitFor("Worked for 1m16s · +213 -435 · /changes · 42.0 tok/s");
    assert.ok(frame.includes("Worked for 5.0s · aborted · +5 -1 · /changes · 30.0 tok/s"), frame);
    assert.ok(frame.includes("Worked for 2.0s · 50.0 tok/s"), frame);
    assert.ok(!frame.includes("/changes · 50.0 tok/s"), frame);
    assert.ok(!frame.includes("Worked for 2.0s · +"), frame);
    assertColor("Worked for 1m16s", theme.muted);
    assertColor("+213", theme.success);
    assertColor("-435", theme.diffDel);
    assertColor("42.0 tok/s", theme.muted);
    assertColor("30.0 tok/s", theme.muted);
    await settle(() => setup.mockInput.typeText("/changes"));
    await settle(() => setup.mockInput.pressEnter());
    await waitFor("+218 -436");
    await waitFor("+200 -400");
    assertColor("+218", theme.success);
    assertColor("-436", theme.diffDel);
    assertColor("+200", theme.success);
    assertColor("-400", theme.diffDel);
    const pager = services.overlay.getState();
    assert.equal(pager.kind, "pager");
    if (pager.kind === "pager") assert.ok((await pager.source!.readAll()).includes(savedChanges[0]!.path));
    await settle(() => setup.mockInput.pressKey("\x1b[F"));
    await waitFor("+18 -36 src/old.ts");
    assertColor("+18", theme.success);
    assertColor("-36", theme.diffDel);
    await settle(() => setup.mockInput.typeText("q"));
    await settle(() => { services.session.reset({ mintNewId: true }); services.transcript.reset(); });
    await settle(() => setup.mockInput.typeText("/changes"));
    await settle(() => setup.mockInput.pressEnter());
    const empty = await waitFor("No line changes recorded in this session.");
    assert.ok(!empty.includes("+218 -436"), empty);
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
for (const width of [120, 60]) {
  const services = createCompositionRoot({
    noHistory: true, provider: "free", model: "fixture-model",
    updates: { async check() { return { state: "current", currentVersion: "0.0.0", updateAvailable: false }; } },
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 45 }),
  });
  services.session.loadHistory([], { sessionId: `diffed-change-${width}`, transcript: diffedChangeTranscript });
  services.transcript.hydrate(hydrateFromClassicTranscript(diffedChangeTranscript).state);
  attachCommandHandlers(services);
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width, height: 45, kittyKeyboard: true, useThread: false });
  const theme = themeFor(services.capabilities.themeHint);
  const spans = () => setup.captureSpans().lines.flatMap((line) => line.spans);
  async function settle(action: () => unknown = () => undefined): Promise<string> {
    await act(async () => { await action(); });
    await act(async () => { await setup.flush(); });
    return setup.captureCharFrame().replace(/[│║]/g, "").replace(/\s+/g, " ");
  }
  async function waitFor(text: string): Promise<string> {
    for (let attempt = 0; attempt < 60; attempt++) {
      const frame = await settle();
      if (frame.includes(text)) return frame;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
    }
    throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`);
  }
  function spanOn(row: string, text: string) {
    const line = setup.captureSpans().lines.find((candidate) => candidate.spans.map((span) => span.text).join("").includes(row));
    assert.ok(line, `Missing row: ${row}`);
    const span = line.spans.find((candidate) => candidate.text.includes(text));
    assert.ok(span, `Missing ${text} on ${row}`);
    return span;
  }
  try {
    await settle(() => setup.mockInput.typeText("/changes"));
    await settle(() => setup.mockInput.pressEnter());
    await waitFor("+1 -1 /repo/src/answer.ts");
    await settle(() => setup.mockInput.pressKey("\x1b[F"));
    const frame = await waitFor("7 + const answer = 42;");
    assert.ok(frame.includes("edit · /repo/src/answer.ts"), frame);
    assert.ok(frame.includes("7 - const v6 = 6;"), frame);
    assert.ok(frame.includes("create · /repo/tools/run.py"), frame);
    assert.ok(frame.includes("1 + def run():"), frame);
    assert.ok(!frame.includes("diff not kept"), frame);
    const added = spanOn("+ const answer = 42;", "const");
    assert.deepEqual(added.fg.toInts(), RGBA.fromHex(syntaxColor("keyword", theme)).toInts());
    assert.deepEqual(added.bg.toInts(), RGBA.fromHex(theme.diffAddBg).toInts());
    assert.deepEqual(spanOn("- const v6 = 6;", "const").bg.toInts(), RGBA.fromHex(theme.diffDelBg).toInts());
    assert.deepEqual(spanOn("+ def run():", "def").fg.toInts(), RGBA.fromHex(syntaxColor("keyword", theme)).toInts());
    assert.ok(spans().some((span) => span.text.includes("+1") && span.fg.toInts().join() === RGBA.fromHex(theme.success).toInts().join()));
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
{
  const transcript = largeChangeTranscript(120);
  const services = createCompositionRoot({
    noHistory: true, provider: "free", model: "fixture-model",
    updates: { async check() { return { state: "current", currentVersion: "0.0.0", updateAvailable: false }; } },
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 40 }),
  });
  services.session.loadHistory([], { sessionId: "large-changes", transcript });
  services.transcript.hydrate(hydrateFromClassicTranscript(transcript).state);
  attachCommandHandlers(services);
  const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), { width: 100, height: 40, kittyKeyboard: true, useThread: false });
  async function settle(action: () => unknown = () => undefined): Promise<string> {
    await act(async () => { await action(); });
    await act(async () => { await setup.flush(); });
    return setup.captureCharFrame().replace(/[│║]/g, "").replace(/\s+/g, " ");
  }
  async function waitFor(text: string): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const frame = await settle();
      if (frame.includes(text)) return frame;
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    }
    throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`);
  }
  try {
    await settle(() => setup.mockInput.typeText("/changes"));
    await settle(() => setup.mockInput.pressEnter());
    const opened = await waitFor("Total · +7200 -0 · 120 files");
    assert.ok(!/page \d+\/\d+/.test(opened), opened);
    const pager = services.overlay.getState();
    assert.equal(pager.kind === "pager" && pager.source?.layout, "continuous");
    await settle(() => setup.mockInput.pressKey("\x1b[F"));
    const bottom = await waitFor("60 + export const FILE_99_LINE_59 = 59;");
    assert.ok(!/page \d+\/\d+/.test(bottom), bottom);
  } finally {
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    await setup.renderer.idle();
  }
}
assert.equal(requests.mock.calls.length, 0);
console.log("Native changes passed: persistent per-run summaries, session totals, per-file lists, per-file diffs, long filenames and empty sessions at 120/80/40 columns");
