import {
  THINKING_STREAM_IDLE_TIMEOUT_MS,
  THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS,
} from "./http.js";

export interface StreamIdleWatchdog {
  readonly controller: AbortController;
  readonly noteTransportActivity: () => void;
  readonly resetIdleTimer: () => void;
  readonly armInitialTransport: () => void;
  readonly armOutputTimer: () => void;
  readonly clear: () => void;
  readonly fired: () => boolean;
  readonly firedWatchdog: () => "transport" | "output" | undefined;
  readonly firedBudgetMs: () => number;
  readonly sawTransportActivity: () => boolean;
  readonly sawStreamProgress: () => boolean;
}

export function createStreamIdleWatchdog(): StreamIdleWatchdog {
  const idleTimeoutMs = THINKING_STREAM_IDLE_TIMEOUT_MS;
  const initialIdleTimeoutMs = THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS;
  const outputIdleTimeoutMs = Math.round(
    Math.max(idleTimeoutMs, initialIdleTimeoutMs) * 1.5,
  );
  const controller = new AbortController();
  let transportTimer: NodeJS.Timeout | undefined;
  let outputTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  let firedWatchdog: "transport" | "output" | undefined;
  let firedBudgetMs = initialIdleTimeoutMs;
  let sawTransportActivity = false;
  let sawStreamProgress = false;
  const fireStall = (
    watchdog: "transport" | "output",
    budgetMs: number,
  ): void => {
    if (idleFired) return;
    idleFired = true;
    firedWatchdog = watchdog;
    firedBudgetMs = budgetMs;
    controller.abort();
  };
  const armTransportTimer = (budgetMs: number): void => {
    if (transportTimer) clearTimeout(transportTimer);
    transportTimer = setTimeout(
      () => fireStall("transport", budgetMs),
      budgetMs,
    );
  };
  const armOutputTimer = (): void => {
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = setTimeout(
      () => fireStall("output", outputIdleTimeoutMs),
      outputIdleTimeoutMs,
    );
  };
  const noteTransportActivity = (): void => {
    sawTransportActivity = true;
    armTransportTimer(idleTimeoutMs);
  };
  const resetIdleTimer = (): void => {
    sawStreamProgress = true;
    noteTransportActivity();
    armOutputTimer();
  };
  armTransportTimer(initialIdleTimeoutMs);
  armOutputTimer();
  return {
    controller,
    noteTransportActivity,
    resetIdleTimer,
    armInitialTransport: () => armTransportTimer(initialIdleTimeoutMs),
    armOutputTimer,
    clear: () => {
      if (transportTimer) clearTimeout(transportTimer);
      if (outputTimer) clearTimeout(outputTimer);
      transportTimer = undefined;
      outputTimer = undefined;
    },
    fired: () => idleFired,
    firedWatchdog: () => firedWatchdog,
    firedBudgetMs: () => firedBudgetMs,
    sawTransportActivity: () => sawTransportActivity,
    sawStreamProgress: () => sawStreamProgress,
  };
}
