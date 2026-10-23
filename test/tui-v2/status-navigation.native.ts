import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, createElement, createRef } from "react";
import type { BoxRenderable, TextareaRenderable } from "@opentui/core";
import { testRender } from "@opentui/react/test-utils";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { themeFor } from "../../src/ui-core/rendering/theme.js";
import { StatusLine } from "../../src/tui-v2/components/status/status-line.js";
import { ComposerInputBox } from "../../src/tui-v2/components/composer/composer-input-box.js";
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
  const theme = themeFor("dark");
  const composerRef = createRef<BoxRenderable>();
  const noop = (): void => {};
  const setup = await testRender(createElement("box", {
    style: { width, flexDirection: "column" },
  }, createElement(ComposerInputBox, {
    theme,
    boxRef: composerRef,
    editorRef: createRef<TextareaRenderable>(),
    focused: false,
    width,
    boxHeight: 3,
    metaShown: "",
    chromeFg: theme.inputBorder,
    keyBindings: undefined as never,
    onMouseDown: noop,
    onMouseScroll: noop,
    onSubmit: noop,
    onContentChange: noop,
    onCursorChange: noop,
    onKeyDown: noop,
  }), createElement(StatusLine, {
    session: services.session,
    mode: "agent",
    theme,
    activity: "checking status spacing",
    width,
    hasActivePlan: true,
    planVisible: false,
    onJumpBottom: () => { jumps += 1; publishTranscriptScrollMetrics({ linesAbove: 240, linesBelow: 0 }); },
    onFocusComposer: () => { focused += 1; },
  })), { width, height: 5, useThread: false, useMouse: true });
  const settle = async (action: () => unknown = () => undefined): Promise<void> => {
    await act(async () => { await action(); });
    await act(async () => { await setup.flush(); });
  };
  const button = () => setup.renderer.root.findDescendantById("jump-to-latest");
  const assertFooterSpacing = (): { row: string; contextLeft: number } => {
    const composer = composerRef.current;
    assert.ok(composer, "the composer is mounted");
    const row = setup.captureCharFrame().split("\n")[composer.y + composer.height]!;
    assert.match(row, /AGENT/, row);
    const context = /ctx \S+\s*$/.exec(row);
    assert.ok(context, row);
    assert.equal(context.index + context[0].trimEnd().length, composer.x + composer.width - 1, `context stays inside the composer border: ${row}`);
    const beforeContext = row.slice(0, context.index);
    const branchStart = beforeContext.indexOf("\ue0a0");
    if (branchStart >= 0 && beforeContext.slice(branchStart + 1).trim() !== "") {
      const gap = beforeContext.match(/ +$/)?.[0].length ?? 0;
      assert.equal(gap, 3, `location/branch and context have a three-column gap: ${row}`);
    }
    return { row, contextLeft: context.index };
  };
  const assertSpacing = (): void => {
    const { row, contextLeft } = assertFooterSpacing();
    const target = button();
    assert.ok(target, "older content exposes the jump control");
    assert.ok(target.x >= 0 && target.x + target.width <= width, row);
    assert.ok(target.x + target.width <= contextLeft - 3, `jump control stays clear of context: ${JSON.stringify({ width, x: target.x, jumpWidth: target.width, contextLeft, row })}`);
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
  const branchMounted = async (): Promise<void> => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (setup.renderer.root.findDescendantById("status-git-branch")) return;
      await settle(() => new Promise((resolve) => setTimeout(resolve, 25)));
    }
    throw new Error("status-git-branch never mounted");
  };
  try {
    await settle();
    await branchMounted();
    await settle();
    assertFooterSpacing();
    await settle(() => publishTranscriptScrollMetrics({ linesAbove: 0, linesBelow: 240 }));
    assertSpacing();
    await settle(() => { active = services.session.submit("Keep the spacing test running"); });
    assert.equal(services.session.getState().running, true);
    assertSpacing();
    const target = button()!;
    await settle(() => setup.mockMouse.click(target.x + 1, target.y));
    assert.equal(jumps, 1, JSON.stringify({ width, x: target.x, y: target.y, frame: setup.captureCharFrame() }));
    assert.equal(button(), undefined);
    assert.doesNotMatch(setup.captureCharFrame(), /\[↓ (?:Latest|Jump to latest)\]/);
    assertFooterSpacing();
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
