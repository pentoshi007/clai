import type { ToolResult } from "../../types.js";

export interface ToolWatchdogInput {
  readonly toolName: string;
  readonly stallBudgetMs: number;
  readonly hardBudgetMs: number;
  readonly graceMs: number;
  readonly controller: AbortController;
  readonly notify: (message: string) => void;
}

export interface ToolWatchdogState {
  readonly stalledByWatchdog: boolean;
  readonly hardTimedOut: boolean;
  readonly forceSettled: boolean;
}

export interface ToolWatchdog {
  readonly resetStallTimer: () => void;
  readonly run: (startWork: () => Promise<ToolResult>) => Promise<ToolResult>;
  readonly state: () => ToolWatchdogState;
  readonly abortResult: () => ToolResult;
  readonly dispose: () => void;
}

interface WatchdogRuntime {
  stalled: boolean;
  hardTimedOut: boolean;
  forceSettled: boolean;
  settled: boolean;
  stallTimer: NodeJS.Timeout | undefined;
  hardTimer: NodeJS.Timeout | undefined;
  graceTimer: NodeJS.Timeout | undefined;
  forceResolve: ((result: ToolResult) => void) | undefined;
}

const unref = (timer: NodeJS.Timeout): void => {
  timer.unref?.();
};

const seconds = (ms: number): number => Math.round(ms / 1000);

const armStallTimer = (
  input: ToolWatchdogInput,
  runtime: WatchdogRuntime,
): void => {
  if (runtime.stallTimer) clearTimeout(runtime.stallTimer);
  runtime.stallTimer = setTimeout(() => {
    if (input.controller.signal.aborted) return;
    runtime.stalled = true;
    input.notify(
      `${input.toolName} has been running for >${seconds(input.stallBudgetMs)}s without output — cancelling stalled tool`,
    );
    input.controller.abort();
  }, input.stallBudgetMs);
  unref(runtime.stallTimer);
};

const forceCancelResult = (
  input: ToolWatchdogInput,
  runtime: WatchdogRuntime,
): ToolResult => {
  runtime.forceSettled = true;
  if (runtime.stalled) {
    return {
      ok: false,
      output: `Tool timed out after ${seconds(input.stallBudgetMs)}s without output (force-cancelled).`,
      exitCode: 124,
    };
  }
  if (runtime.hardTimedOut) {
    return {
      ok: false,
      output: `Tool hard-timeout after ${seconds(input.hardBudgetMs)}s — cancelled.`,
      exitCode: 124,
    };
  }
  return {
    ok: false,
    output: "Tool aborted before it could complete (force-cancelled).",
    exitCode: 130,
  };
};

const armGraceForceSettle = (
  input: ToolWatchdogInput,
  runtime: WatchdogRuntime,
): void => {
  if (runtime.settled || runtime.graceTimer) return;
  runtime.graceTimer = setTimeout(() => {
    if (runtime.settled) return;
    input.notify(`${input.toolName} did not stop after cancel — force-settling`);
    runtime.settled = true;
    runtime.forceResolve?.(forceCancelResult(input, runtime));
  }, input.graceMs);
  unref(runtime.graceTimer);
};

const armHardTimer = (
  input: ToolWatchdogInput,
  runtime: WatchdogRuntime,
): void => {
  runtime.hardTimer = setTimeout(() => {
    if (runtime.settled) return;
    runtime.hardTimedOut = true;
    input.notify(
      `${input.toolName} exceeded ${seconds(input.hardBudgetMs)}s hard budget — cancelling`,
    );
    if (!input.controller.signal.aborted) input.controller.abort();
    armGraceForceSettle(input, runtime);
  }, input.hardBudgetMs);
  unref(runtime.hardTimer);
};

const trackSettlement = (
  work: Promise<ToolResult>,
  runtime: WatchdogRuntime,
): Promise<ToolResult> =>
  work.then(
    (result) => {
      runtime.settled = true;
      return result;
    },
    (error) => {
      runtime.settled = true;
      return Promise.reject(error);
    },
  );

const abortResultFor = (
  input: ToolWatchdogInput,
  runtime: WatchdogRuntime,
): ToolResult => {
  if (runtime.stalled) {
    return {
      ok: false,
      output: `Tool timed out after ${input.stallBudgetMs / 1_000}s without output.`,
      exitCode: 124,
    };
  }
  if (runtime.hardTimedOut) {
    return {
      ok: false,
      output: `Tool hard-timeout after ${seconds(input.hardBudgetMs)}s — cancelled.`,
      exitCode: 124,
    };
  }
  return {
    ok: false,
    output: "Tool aborted before it could complete.",
    exitCode: 130,
  };
};

export const createToolWatchdog = (input: ToolWatchdogInput): ToolWatchdog => {
  const runtime: WatchdogRuntime = {
    stalled: false,
    hardTimedOut: false,
    forceSettled: false,
    settled: false,
    stallTimer: undefined,
    hardTimer: undefined,
    graceTimer: undefined,
    forceResolve: undefined,
  };

  const run = (startWork: () => Promise<ToolResult>): Promise<ToolResult> => {
    const tracked = trackSettlement(startWork(), runtime);
    const forced = new Promise<ToolResult>((resolve) => {
      runtime.forceResolve = resolve;
    });
    armHardTimer(input, runtime);
    const signal = input.controller.signal;
    if (signal.aborted) armGraceForceSettle(input, runtime);
    else {
      signal.addEventListener(
        "abort",
        () => armGraceForceSettle(input, runtime),
        { once: true },
      );
    }
    return Promise.race([tracked, forced]);
  };

  return {
    resetStallTimer: () => armStallTimer(input, runtime),
    run,
    state: () => ({
      stalledByWatchdog: runtime.stalled,
      hardTimedOut: runtime.hardTimedOut,
      forceSettled: runtime.forceSettled,
    }),
    abortResult: () => abortResultFor(input, runtime),
    dispose: () => {
      if (runtime.stallTimer) clearTimeout(runtime.stallTimer);
      if (runtime.hardTimer) clearTimeout(runtime.hardTimer);
      if (runtime.graceTimer) clearTimeout(runtime.graceTimer);
    },
  };
};
