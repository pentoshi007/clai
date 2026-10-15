import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement } from "react";
import { testRender } from "@opentui/react/test-utils";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { StatusLine } from "../../src/tui-v2/components/status/status-line.js";
import { publishTranscriptScrollMetrics } from "../../src/tui-v2/components/transcript/transcript-scroll-port.js";

async function verify(width: number): Promise<void> {
  let finish: (() => void) | undefined;
  let active: Promise<void> | undefined;
  let jumps = 0;
  let focused = 0;
  const services = createCompositionRoot({
    noHistory: true,
    agent: {
      async runTurn(_request, handlers) {
        await new Promise<void>(resolve => {
          finish = resolve;
          handlers.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return createTurnOutcome({ status: "succeeded", answer: "done", steps: 0, remainingCriteria: [] });
      },
    },
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  });
  services.session.enqueue("queued first");
  services.session.enqueue("queued second");
  const queued = services.session.getState().queued;
  const setup = await testRender(createElement(StatusLine, {
    session: services.session,
    mode: "agent",
    theme: themeFor("dark"),
    activity: "checking status spacing",
    width,
    hasActivePlan: true,
    planVisible: false,
    onJumpBottom: () => { jumps += 1; publishTranscriptScrollMetrics({ linesAbove: 240, linesBelow: 0 }); },
    onFocusComposer: () => { focused += 1; },
  }), { width, height: 3, useThread: false, useMouse: true });
  const settle = async (action: () => unknown = () => undefined): Promise<void> => {
    await act(async () => { await action(); await setup.flush(); });
  };
  const button = () => setup.renderer.root.findDescendantById("jump-to-latest");
  const assertSpacing = (): void => {
    const target = button();
    assert.ok(target, "older content exposes the jump control");
    const row = setup.captureCharFrame().split("\n")[target.y]!;
    assert.ok(target.x >= 0 && target.x + target.width <= width, row);
    assert.match(row, /AGENT/, row);
    assert.match(row, /ctx 0/, row);
    if (width < 120) return;
    const before = Array.from(row).slice(0, target.x).join("");
    assert.match(before, /Tasks/, row);
    assert.match(before, /2(?: queued|q)/, row);
    const slot = setup.renderer.root.findDescendantById("status-jump-slot");
    assert.ok(slot, "the jump control owns a centering slot");
    const leftGap = target.x - slot.x;
    const rightGap = slot.x + slot.width - target.x - target.width;
    assert.ok(leftGap >= (width >= 160 ? 2 : 1), `jump control needs breathing room after Tasks/queue: ${JSON.stringify({ width, leftGap, rightGap, row })}`);
    assert.ok(Math.abs(leftGap - rightGap) <= 2, `jump control must be centered in the empty gap: ${JSON.stringify({ width, leftGap, rightGap, row })}`);
    if (width === 160) console.log(JSON.stringify({ running: services.session.getState().running, width, leftGap, rightGap, row }));
  };
  try {
    await settle(() => publishTranscriptScrollMetrics({ linesAbove: 0, linesBelow: 240 }));
    await act(async () => { await setup.waitFor(() => setup.renderer.root.findDescendantById("status-git-branch") !== undefined); });
    await settle();
    await settle();
    assertSpacing();
    await settle(() => { active = services.session.submit("Keep the spacing test running"); });
    assert.equal(services.session.getState().running, true);
    assertSpacing();
    const target = button()!;
    await settle(() => setup.mockMouse.click(target.x + 1, target.y));
    assert.equal(button(), undefined);
    assert.equal(jumps, 1);
    assert.equal(focused, 1);
    assert.deepEqual(services.session.getState().queued, queued);
  } finally {
    await act(async () => {
      while (services.session.getState().queued.length) services.session.removeQueued(0);
      finish?.();
      await active;
      services.dispose();
      setup.renderer.destroy();
    });
    await setup.renderer.idle();
    publishTranscriptScrollMetrics({ linesAbove: 0, linesBelow: 0 });
  }
}

const originalCwd = process.cwd();
const root = mkdtempSync(join(tmpdir(), "clai-status-spacing-"));
try {
  execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root });
  execFileSync("git", [
    "-c", "user.name=clai test", "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, "no-hooks")}`,
    "commit", "--quiet", "--allow-empty", "-m", "Status spacing fixture",
  ], { cwd: root });
  process.chdir(root);
  for (const branch of ["main", "regression/" + "long-branch-name-".repeat(8)]) {
    execFileSync("git", ["checkout", "--quiet", "-B", branch], { cwd: root });
    for (const width of [40, 52, 68, 80, 120, 160, 240]) await verify(width);
  }
  console.log("Native status navigation passed: centered idle/busy controls with Tasks, queue and short/long branches at 40/52/68/80/120/160/240 columns");
} finally {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
}
