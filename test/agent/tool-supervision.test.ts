import { describe, expect, it } from "vitest";
import type { ToolResult } from "../../src/types.js";
import type { ToolWatchdog } from "../../src/agent/turn/tool-watchdog.js";
import {
  superviseToolExecution,
  type ToolSupervisionPorts,
} from "../../src/agent/turn/tool-execution/supervision.js";

const okResult: ToolResult = { ok: true, output: "done", exitCode: 0 };

const watchdogStub = (
  overrides: {
    run?: ToolWatchdog["run"];
    stalled?: boolean;
    hardTimedOut?: boolean;
    forceSettled?: boolean;
  } = {},
): ToolWatchdog => ({
  resetStallTimer: () => undefined,
  run: overrides.run ?? ((startWork) => startWork()),
  state: () => ({
    stalledByWatchdog: overrides.stalled ?? false,
    hardTimedOut: overrides.hardTimedOut ?? false,
    forceSettled: overrides.forceSettled ?? false,
  }),
  abortResult: () => ({
    ok: false,
    output: "Tool aborted before it could complete.",
    exitCode: 130,
  }),
  dispose: () => undefined,
});

const harness = (
  overrides: Partial<ToolSupervisionPorts> = {},
): { ports: ToolSupervisionPorts; events: string[] } => {
  const events: string[] = [];
  const ports: ToolSupervisionPorts = {
    watchdog: watchdogStub(),
    parentSignal: new AbortController().signal,
    toolSignal: new AbortController().signal,
    isAbortError: () => false,
    liveBytes: () => 0,
    writeToolOutput: (chunk) => events.push(`out:${JSON.stringify(chunk)}`),
    updateJobStatus: (status, exitCode) =>
      events.push(`job:${status}:${exitCode ?? "none"}`),
    cleanup: () => events.push("cleanup"),
    ...overrides,
  };
  return { ports, events };
};

describe("tool supervision", () => {
  it("settles a successful run and marks the job exited", async () => {
    const h = harness();
    const outcome = await superviseToolExecution(h.ports, async () => okResult);
    expect(outcome).toEqual({ kind: "settled", result: okResult });
    expect(h.events).toEqual(["job:exited:0", "cleanup"]);
  });

  it("marks a failed result as a failed job", async () => {
    const h = harness();
    await superviseToolExecution(h.ports, async () => ({
      ok: false,
      output: "boom",
      exitCode: 2,
    }));
    expect(h.events).toContain("job:failed:2");
  });

  it("terminates the live output spool only when bytes streamed", async () => {
    const streamed = harness({ liveBytes: () => 12 });
    await superviseToolExecution(streamed.ports, async () => okResult);
    expect(streamed.events[0]).toBe('out:"\\n"');
    const silent = harness();
    await superviseToolExecution(silent.ports, async () => okResult);
    expect(silent.events[0]).toBe("job:exited:0");
  });

  it("reports user cancellation when the parent aborted without a timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({ parentSignal: controller.signal });
    const outcome = await superviseToolExecution(h.ports, async () => okResult);
    expect(outcome.kind).toBe("cancelled");
    expect(outcome.result).toEqual({
      ok: false,
      output: "Cancelled by user.",
      exitCode: 130,
    });
    expect(h.events).toEqual(["cleanup"]);
  });

  it("keeps a watchdog timeout result instead of reporting user cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = harness({
      parentSignal: controller.signal,
      watchdog: watchdogStub({ stalled: true }),
    });
    const outcome = await superviseToolExecution(h.ports, async () => okResult);
    expect(outcome.kind).toBe("settled");
  });

  it("maps a plain thrown error to a tool error result", async () => {
    const h = harness();
    const outcome = await superviseToolExecution(h.ports, async () => {
      throw new Error("exploded");
    });
    expect(outcome).toEqual({
      kind: "settled",
      result: { ok: false, output: "Tool error: exploded", exitCode: 1 },
    });
    expect(h.events).toEqual(["job:failed:1", "cleanup"]);
  });

  it("maps an abort error to the watchdog abort result", async () => {
    const h = harness({ isAbortError: () => true });
    const outcome = await superviseToolExecution(h.ports, async () => {
      throw new Error("aborted");
    });
    expect(outcome.result.exitCode).toBe(130);
    expect(outcome.result.output).toBe(
      "Tool aborted before it could complete.",
    );
  });

  it("always cleans up, even when the work throws", async () => {
    const h = harness();
    await superviseToolExecution(h.ports, async () => {
      throw new Error("x");
    });
    expect(h.events.at(-1)).toBe("cleanup");
  });
});
