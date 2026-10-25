import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { spyOn } from "bun:test";
import { App } from "../../src/tui-v2/app/App.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { getProvider } from "../../src/llm/router.js";
import { asSessionId } from "../../src/app/events/app-event.js";
import { EventSequencer } from "../../src/app/events/sequencer.js";
import { liveJob, liveTool, numberedOutput } from "../fixtures/live-pagers.js";

spyOn(getProvider("free"), "listModels").mockResolvedValue([]);
const requests = spyOn(globalThis, "fetch").mockRejectedValue(new Error("Live pager fixture must not access the network"));
const dir = mkdtempSync(join(tmpdir(), "clai-native-live-pager-"));
const path = join(dir, "output.log");
const job = liveJob(path);
const services = createCompositionRoot({
  noHistory: true, provider: "free", model: "fixture-model", jobs: job.port,
  updates: { async check() { return { state: "current", currentVersion: "0.0.0", updateAvailable: false }; } },
  persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: 100, rows: 30 }),
});
const tool = liveTool(services);
tool.output(numberedOutput(45));
const setup = await testRender(createElement(ServicesProvider, { services, children: createElement(App) }), {
  width: 100, height: 30, kittyKeyboard: true, useThread: false,
});
async function settle(action: () => unknown = () => undefined): Promise<string> {
  await act(async () => { await action(); });
  await act(async () => { await setup.flush(); });
  return setup.captureCharFrame().replace(/[│║]/g, "").replace(/\s+/g, " ");
}
async function waitFor(text: string): Promise<string> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const frame = await settle();
    if (frame.includes(text)) return frame;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  }
  throw new Error(`Missing ${text}: ${setup.captureCharFrame()}`);
}
const type = (text: string) => settle(() => setup.mockInput.typeText(text));
const theme = themeFor(services.capabilities.themeHint);
function assertColor(text: string, token: "userBorder" | "success" | "diffDel"): void {
  const span = setup.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes(text));
  assert.ok(span, setup.captureCharFrame());
  assert.deepEqual(span.fg.toInts(), RGBA.fromHex(theme[token]).toInts(), `${text} uses ${token}`);
}
try {
  await waitFor("stream line");
  const rows = setup.captureCharFrame().split("\n");
  const row = rows.findIndex((line) => line.includes("stream line"));
  assert.ok(row >= 0);
  await settle(() => setup.mockMouse.click(rows[row]!.indexOf("stream line") + 2, row));
  await waitFor("stream line 45");
  assert.equal(services.overlay.getState().kind, "pager", setup.captureCharFrame());
  await settle(() => setup.mockInput.pressKey("\x1b[H"));
  await waitFor("stream line 1");
  assertColor("command: example", "userBorder");
  await settle(() => tool.output("\nAPPENDED_WHILE_PAUSED"));
  let frame = await waitFor("paused");
  assert.ok(!frame.includes("APPENDED_WHILE_PAUSED"), frame);
  await type("l");
  await waitFor("APPENDED_WHILE_PAUSED");
  await settle(() => setup.mockInput.pressKey("\x1b[H"));
  writeFileSync(path, `${numberedOutput(45)}\nFINAL_ARTIFACT_OUTPUT`);
  await settle(() => tool.finish(path));
  frame = await waitFor("finished");
  assertColor("example streaming command", "success");
  assert.ok(frame.includes("stream line 1"), frame);
  assert.ok(!frame.includes("FINAL_ARTIFACT_OUTPUT"), frame);
  await type("l");
  await waitFor("FINAL_ARTIFACT_OUTPUT");
  await type("q");
  assert.equal(services.overlay.getState().kind, "none");

  for (const key of ["t", "v", "enter"]) {
    writeFileSync(path, numberedOutput(45));
    job.update({ status: "running", exitCode: undefined });
    await settle(() => services.overlay.openJobs());
    await waitFor("Background jobs");
    await settle(() => key === "enter" ? setup.mockInput.pressEnter() : setup.mockInput.typeText(key));
    await waitFor("stream line 45");
    assertColor("npm test", "userBorder");
    const state = services.overlay.getState();
    assert.equal(state.kind, "pager");
    appendFileSync(path, "\nDISK_ONLY_APPEND");
    await waitFor("DISK_ONLY_APPEND");
    await settle(() => setup.mockInput.pressKey("\x1b[H"));
    await waitFor("stream line 1");
    appendFileSync(path, "\nPAUSED_DISK_APPEND");
    if (state.kind === "pager") assert.ok((await state.source!.readAll()).includes("PAUSED_DISK_APPEND"));
    const failed = key === "v";
    await settle(() => job.update({ status: failed ? "failed" : "exited", exitCode: failed ? 1 : 0 }));
    frame = await waitFor("finished");
    assertColor("npm test", failed ? "diffDel" : "success");
    assert.ok(frame.includes("stream line 1"), frame);
    assert.ok(!frame.includes("PAUSED_DISK_APPEND"), frame);
    await type("l");
    await waitFor("PAUSED_DISK_APPEND");
    await type("q");
    await waitFor("Background jobs");
    await type("q");
  }
  const sequence = new EventSequencer(asSessionId(services.session.sessionId));
  await settle(() => {
    services.transcript.reset();
    services.transcript.dispatch(sequence.build("compaction-started", { compactionId: "live", beforeTokens: 100_000 }));
    services.transcript.dispatch(sequence.build("compaction-delta", { compactionId: "live", text: numberedOutput(45) }));
  });
  await waitFor("Compacted context");
  const compactRows = setup.captureCharFrame().split("\n");
  const compactRow = compactRows.findIndex((line) => line.includes("Compacted context"));
  await settle(() => setup.mockMouse.click(compactRows[compactRow]!.indexOf("Compacted context") + 2, compactRow));
  await waitFor("stream line 45");
  const compactPager = services.overlay.getState();
  assert.equal(compactPager.kind, "pager");
  await settle(() => services.transcript.dispatch(sequence.build("compaction-delta", { compactionId: "live", text: "\nLIVE_COMPACTION_DELTA" })));
  await waitFor("LIVE_COMPACTION_DELTA");
  await settle(() => setup.mockInput.pressKey("\x1b[H"));
  await waitFor("stream line 1");
  await settle(() => services.transcript.dispatch(sequence.build("compaction-completed", {
    compactionId: "live", summary: `${numberedOutput(45)}\nFINAL_COMPACTION_SUMMARY`, beforeTokens: 100_000, afterTokens: 1_000, contextScope: "message-history",
  })));
  frame = await waitFor("finished");
  assert.ok(frame.includes("stream line 1"), frame);
  assert.ok(!frame.includes("FINAL_COMPACTION_SUMMARY"), frame);
  await type("l");
  await waitFor("FINAL_COMPACTION_SUMMARY");
  await type("q");
  if (compactPager.kind === "pager") assert.throws(() => compactPager.source!.readAll(), /closed/);
  assert.equal(requests.mock.calls.length, 0);
  console.log("Native live pagers passed: tool-output click, compaction click/deltas/final summary, pause/follow, final artifact, t/v/enter job views, disk-only writes, and close");
} finally {
  await act(async () => { services.dispose(); setup.renderer.destroy(); });
  await setup.renderer.idle();
  assert.equal(job.listeners(), 0);
  rmSync(dir, { recursive: true, force: true });
}
