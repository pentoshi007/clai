import { describe, expect, it, vi } from "vitest";
import type { ToolResult } from "../../src/types.js";
import { createToolWatchdog } from "../../src/agent/turn/tool-watchdog.js";

const watchdog = (
  controller: AbortController,
  notices: string[],
  overrides: { stallBudgetMs?: number; hardBudgetMs?: number; graceMs?: number } = {},
) =>
  createToolWatchdog({
    toolName: "shell.exec",
    stallBudgetMs: overrides.stallBudgetMs ?? 30_000,
    hardBudgetMs: overrides.hardBudgetMs ?? 120_000,
    graceMs: overrides.graceMs ?? 2_000,
    controller,
    notify: (message) => notices.push(message),
  });

const ok: ToolResult = { ok: true, output: "done" };

describe("tool watchdog", () => {
  it("resolves the tool result and arms no cancellation", async () => {
    const controller = new AbortController();
    const notices: string[] = [];
    const guard = watchdog(controller, notices);
    await expect(guard.run(() => Promise.resolve(ok))).resolves.toBe(ok);
    expect(notices).toEqual([]);
    expect(guard.state()).toEqual({
      stalledByWatchdog: false,
      hardTimedOut: false,
      forceSettled: false,
    });
    guard.dispose();
  });

  it("propagates a tool rejection unchanged", async () => {
    const controller = new AbortController();
    const guard = watchdog(controller, []);
    const failure = new Error("boom");
    await expect(guard.run(() => Promise.reject(failure))).rejects.toBe(failure);
    guard.dispose();
  });

  it("aborts a stalled tool after the stall budget and warns once", () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const notices: string[] = [];
      const guard = watchdog(controller, notices, { stallBudgetMs: 1_000 });
      guard.resetStallTimer();
      vi.advanceTimersByTime(1_000);
      expect(controller.signal.aborted).toBe(true);
      expect(notices).toEqual([
        "shell.exec has been running for >1s without output — cancelling stalled tool",
      ]);
      expect(guard.state().stalledByWatchdog).toBe(true);
      expect(guard.abortResult()).toEqual({
        ok: false,
        output: "Tool timed out after 1s without output.",
        exitCode: 124,
      });
      guard.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restarts the stall countdown on output", () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const guard = watchdog(controller, [], { stallBudgetMs: 1_000 });
      guard.resetStallTimer();
      vi.advanceTimersByTime(900);
      guard.resetStallTimer();
      vi.advanceTimersByTime(900);
      expect(controller.signal.aborted).toBe(false);
      vi.advanceTimersByTime(200);
      expect(controller.signal.aborted).toBe(true);
      guard.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-settles a hung tool after the hard budget and grace window", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const notices: string[] = [];
      const guard = watchdog(controller, notices, {
        hardBudgetMs: 5_000,
        graceMs: 1_000,
      });
      const pending = guard.run(() => new Promise<ToolResult>(() => {}));
      vi.advanceTimersByTime(5_000);
      expect(controller.signal.aborted).toBe(true);
      vi.advanceTimersByTime(1_000);
      await expect(pending).resolves.toEqual({
        ok: false,
        output: "Tool hard-timeout after 5s — cancelled.",
        exitCode: 124,
      });
      expect(notices).toEqual([
        "shell.exec exceeded 5s hard budget — cancelling",
        "shell.exec did not stop after cancel — force-settling",
      ]);
      expect(guard.state()).toEqual({
        stalledByWatchdog: false,
        hardTimedOut: true,
        forceSettled: true,
      });
      guard.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("force-settles after an external abort that the tool ignores", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const notices: string[] = [];
      const guard = watchdog(controller, notices, { graceMs: 500 });
      const pending = guard.run(() => new Promise<ToolResult>(() => {}));
      controller.abort();
      vi.advanceTimersByTime(500);
      await expect(pending).resolves.toEqual({
        ok: false,
        output: "Tool aborted before it could complete (force-cancelled).",
        exitCode: 130,
      });
      expect(notices).toEqual([
        "shell.exec did not stop after cancel — force-settling",
      ]);
      guard.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms the grace window immediately when the signal is already aborted", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      controller.abort();
      const guard = watchdog(controller, [], { graceMs: 100 });
      const pending = guard.run(() => new Promise<ToolResult>(() => {}));
      vi.advanceTimersByTime(100);
      await expect(pending).resolves.toMatchObject({ exitCode: 130 });
      guard.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the plain abort message when nothing timed out", () => {
    const guard = watchdog(new AbortController(), []);
    expect(guard.abortResult()).toEqual({
      ok: false,
      output: "Tool aborted before it could complete.",
      exitCode: 130,
    });
    guard.dispose();
  });
});
