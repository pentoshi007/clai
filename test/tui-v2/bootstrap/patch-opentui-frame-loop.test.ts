import { CliRenderer } from "@opentui/core";
import { describe, expect, it, vi } from "vitest";
import { patchOpenTuiFrameLoop } from "../../../src/tui-v2/bootstrap/patch-opentui-frame-loop.js";

interface RenderLoopTarget {
  renderTimeout: unknown;
  _isRunning: boolean;
  feedIdleRenderScheduled: boolean;
  renderStats: { fps: number };
  clock: { now(): number };
  normalizeClockTime(now: number): number;
  loop: ReturnType<typeof vi.fn>;
}

function renderLoopTarget(renderTimeout: unknown): RenderLoopTarget {
  return {
    renderTimeout,
    _isRunning: true,
    feedIdleRenderScheduled: false,
    renderStats: { fps: 0 },
    clock: { now: () => 0 },
    normalizeClockTime: (now) => now,
    loop: vi.fn(),
  };
}

function startRenderLoop(target: RenderLoopTarget): void {
  const proto = CliRenderer.prototype as unknown as { startRenderLoop(this: RenderLoopTarget): void };
  proto.startRenderLoop.call(target);
}

describe("patchOpenTuiFrameLoop", () => {
  it("is idempotent and lets an already scheduled frame start live rendering", () => {
    patchOpenTuiFrameLoop();
    patchOpenTuiFrameLoop();
    const scheduled = renderLoopTarget(setTimeout(() => undefined, 0));
    try {
      startRenderLoop(scheduled);
      expect(scheduled.loop).not.toHaveBeenCalled();
    } finally {
      clearTimeout(scheduled.renderTimeout as ReturnType<typeof setTimeout>);
    }
  });

  it("starts the loop immediately when no frame is scheduled", () => {
    patchOpenTuiFrameLoop();
    const idle = renderLoopTarget(null);
    startRenderLoop(idle);
    expect(idle.loop).toHaveBeenCalledTimes(1);
  });
});
