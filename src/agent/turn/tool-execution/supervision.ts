import type { ToolResult } from "../../../types.js";
import type { ToolWatchdog } from "../tool-watchdog.js";

export interface ToolSupervisionPorts {
  readonly watchdog: ToolWatchdog;
  readonly parentSignal: AbortSignal;
  readonly toolSignal: AbortSignal;
  readonly isAbortError: (error: Error, signal: AbortSignal) => boolean;
  readonly liveBytes: () => number;
  readonly writeToolOutput: (chunk: string) => void;
  readonly updateJobStatus: (
    status: "exited" | "failed",
    exitCode: number | undefined,
  ) => void;
  readonly cleanup: () => void;
}

export type ToolSupervisionOutcome =
  | { readonly kind: "settled"; readonly result: ToolResult }
  | { readonly kind: "cancelled"; readonly result: ToolResult };

const CANCELLED_BY_USER: ToolResult = {
  ok: false,
  output: "Cancelled by user.",
  exitCode: 130,
};

const cancelledByUser = (
  ports: ToolSupervisionPorts,
): boolean => {
  const state = ports.watchdog.state();
  return (
    ports.parentSignal.aborted &&
    !state.stalledByWatchdog &&
    !state.hardTimedOut
  );
};

const toolErrorResult = (error: Error): ToolResult => ({
  ok: false,
  output: `Tool error: ${error.message}`,
  exitCode: 1,
});

export const superviseToolExecution = async (
  ports: ToolSupervisionPorts,
  startWork: () => Promise<ToolResult>,
): Promise<ToolSupervisionOutcome> => {
  try {
    const result = await ports.watchdog.run(startWork);
    if (cancelledByUser(ports)) {
      return { kind: "cancelled", result: CANCELLED_BY_USER };
    }
    if (ports.liveBytes() > 0) ports.writeToolOutput("\n");
    ports.updateJobStatus(result.ok ? "exited" : "failed", result.exitCode);
    return { kind: "settled", result };
  } catch (toolError) {
    ports.updateJobStatus("failed", 1);
    const error =
      toolError instanceof Error ? toolError : new Error(String(toolError));
    const forceSettled = ports.watchdog.state().forceSettled;
    if (!ports.isAbortError(error, ports.toolSignal) && !forceSettled) {
      return { kind: "settled", result: toolErrorResult(error) };
    }
    if (cancelledByUser(ports)) {
      return { kind: "cancelled", result: CANCELLED_BY_USER };
    }
    return { kind: "settled", result: ports.watchdog.abortResult() };
  } finally {
    ports.cleanup();
  }
};
