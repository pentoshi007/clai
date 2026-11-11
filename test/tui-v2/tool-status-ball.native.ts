import assert from "node:assert/strict";
import { spyOn } from "bun:test";
import { act, createElement, useState, type Dispatch, type SetStateAction } from "react";
import { testRender } from "@opentui/react/test-utils";
import { RGBA } from "@opentui/core";
import { ToolCard } from "../../src/tui-v2/components/transcript/tool-card.js";
import { TerminalDimensionsContext } from "../../src/tui-v2/hooks/terminal-dimensions.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { ServicesProvider } from "../../src/ui-core/react/providers.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { TOOL_BALL_INTERVAL_MS, TOOL_BALL_WIDTH } from "../../src/ui-core/rendering/tool-status-ball.js";
import { asToolCallId } from "../../src/app/events/app-event.js";
import type { ToolItem } from "../../src/ui-core/state/transcript-types.js";

let now = 0;
const clock = spyOn(Date, "now").mockImplementation(() => now);
const intervals = spyOn(globalThis, "setInterval");
const clear = spyOn(globalThis, "clearInterval");
const theme = themeFor("dark");
const RED = RGBA.fromInts(240, 82, 78, 255);
const GREEN = RGBA.fromInts(64, 204, 123, 255);
const initial: ToolItem = {
  id: "ball-tool", sequence: 1, turnId: undefined, timestamp: 0, kind: "tool", toolCallId: asToolCallId("ball-call"),
  name: "shell.exec", argsDisplay: "printf ready", pending: true, status: "queued", exitCode: undefined,
  summary: undefined, artifactPath: undefined, reason: undefined, outputBytes: 0, fileChanges: undefined,
};

for (const width of [40, 80, 120]) {
  now = 0;
  const services = createCompositionRoot({
    noHistory: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
    capabilities: detectCapabilities({ env: { COLORTERM: "truecolor" }, stdoutIsTTY: true, stdinIsTTY: true, columns: width, rows: 20 }),
  });
  let update: Dispatch<SetStateAction<ToolItem>> = () => { throw new Error("Fixture not mounted"); };
  function Fixture() {
    const [item, setItem] = useState(initial);
    update = setItem;
    return createElement(ToolCard, {
      item, theme, services, spool: services.session.spool, expanded: false, onToggle() {}, contentWidth: width,
    });
  }
  const start = intervals.mock.calls.length;
  const setup = await testRender(createElement(ServicesProvider, {
    services,
    children: createElement(TerminalDimensionsContext.Provider, { value: { width, height: 20 }, children: createElement(Fixture) }),
  }), { width, height: 20, useThread: false });
  const settle = async (action: () => void = () => {}): Promise<void> => {
    await act(async () => { action(); });
    await act(async () => { await setup.flush(); });
  };
  const ball = () => {
    const lines = setup.captureSpans().lines;
    const row = setup.captureCharFrame().split("\n").findIndex((line) => line.includes("shell.exec"));
    assert.ok(row >= 0, setup.captureCharFrame());
    const span = lines[row]!.spans.find((candidate) => candidate.text.includes("●"));
    assert.ok(span, `Row ${row} carries the ball: ${setup.captureCharFrame()}`);
    assert.equal(span.width, TOOL_BALL_WIDTH, "The ball occupies one cell");
    assert.ok(!lines[row + 1]?.spans.some((candidate) => candidate.text.includes("●")), "The ball stays inside its heading row");
    return span;
  };
  const ballTimer = () => {
    const index = intervals.mock.calls.findLastIndex((args, position) => position >= start && args[1] === TOOL_BALL_INTERVAL_MS);
    assert.ok(index >= start, "Active tools run the ball timer");
    return intervals.mock.results[index]!.value;
  };
  try {
    await settle();
    const timer = ballTimer();
    const tick = intervals.mock.calls.findLast((args, position) => position >= start && args[1] === TOOL_BALL_INTERVAL_MS)![0] as () => void;
    assert.deepEqual(ball().fg.toInts(), RED.toInts(), "Pending starts on the first palette colour");
    await settle(() => { now = TOOL_BALL_INTERVAL_MS; tick(); });
    assert.deepEqual(ball().fg.toInts(), GREEN.toInts(), "Pending rotates to the next colour");
    await settle(() => { update({ ...initial, pending: false, status: "running", startedAt: 0 }); });
    const running = ball().fg.toInts();
    await settle(() => { now += TOOL_BALL_INTERVAL_MS; tick(); });
    assert.notDeepEqual(ball().fg.toInts(), running, "Running keeps rotating");
    for (const status of ["ok", "failed", "blocked"] as const) {
      await settle(() => { update({ ...initial, pending: false, status, endedAt: now }); });
      const settled = ball().fg.toInts();
      assert.ok(clear.mock.calls.some(([value]) => value === timer), "Completion stops the ball timer");
      const expected = status === "ok" ? theme.success : theme.diffDel;
      assert.deepEqual(settled, RGBA.fromHex(expected).toInts(), `${status} uses its semantic colour`);
      await settle(() => { now += 1000; setup.renderer.requestRender(); });
      assert.deepEqual(ball().fg.toInts(), settled, `${status} stays static`);
    }
    await settle(() => { update(initial); });
    const activeTimer = ballTimer();
    await act(async () => { services.dispose(); setup.renderer.destroy(); });
    assert.ok(clear.mock.calls.some(([value]) => value === activeTimer), "Unmount stops active ball timers");
    console.log(`Native tool-status ball: ${width} columns, one-cell ball, rotation and terminal-state cleanup passed`);
  } finally {
    services.dispose();
    setup.renderer.destroy();
    await setup.renderer.idle();
  }
}
clock.mockRestore();
intervals.mockRestore();
clear.mockRestore();
console.log("Native tool-status balls passed");
