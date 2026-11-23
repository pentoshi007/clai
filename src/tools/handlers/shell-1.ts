import { responderJobOptions } from "./responder-job-options.js";
import type { ToolResult } from "../../types.js";
import { getAllowInteractiveStdinInherit, looksInteractiveStdin, shellExec } from "../shell.js";
import { resolveShellJobLaunch, SHELL_JOB_TITLE_REQUIRED } from "../shell/job-launch.js";
import { DEFAULT_SHELL_TIMEOUT_MS } from "../shell/timeout.js";
import { jobManager } from "../jobs.js";
import { prepareRtkExecution } from "../rtk/rewrite.js";
import type { ToolHandler, ToolRunOptions } from "../tool-types.js";
import { prepareElevatedBackgroundCommand, tryRunElevatedWithoutTty } from "../elevated-shell.js";
import { optionalNumber, optionalString, requireString } from "./args.js";

async function startShellJob(
  command: string,
  cwd: string | undefined,
  { name, responder }: { name: string; responder: boolean },
  options?: ToolRunOptions,
): Promise<ToolResult> {
  const elevated = await prepareElevatedBackgroundCommand(command, {
    cwd,
    signal: options?.signal,
    onOutput: options?.onOutput,
    requestSecret: options?.requestSecret,
  });
  if (elevated && !elevated.prepared) return elevated.result;
  const execution = await prepareRtkExecution(command, options?.signal, options?.sessionId);
  return jobManager.startJob(elevated?.prepared ? elevated.spec : execution.command, {
    cwd,
    requestedCommand: command,
    env: execution.env,
    onSpawn: execution.onSpawn,
    authorization: options?.engagementAuthorization,
    name,
    ...responderJobOptions(options),
    responder,
    wakeOnCompletion: responder,
  });
}

async function runForegroundShell(
  command: string,
  cwd: string | undefined,
  timeoutMs: number,
  options?: ToolRunOptions,
): Promise<ToolResult> {
  if (looksInteractiveStdin(command)) {
    const elevated = await tryRunElevatedWithoutTty(command, {
      cwd,
      timeoutMs,
      signal: options?.signal,
      onOutput: options?.onOutput,
      requestSecret: options?.requestSecret,
    });
    if (elevated) return elevated;
    const isRoot = process.getuid?.() === 0;
    if (!isRoot && !getAllowInteractiveStdinInherit()) {
      return {
        ok: false,
        exitCode: 1,
        output:
          "This command needs an interactive password prompt, which this frontend cannot show without freezing the UI. " +
          "Run it in an interactive session (terminal.start, then answer the prompt via terminal.send), " +
          "or re-run from the clai TUI where the secure password modal is available.",
      };
    }
  }

  const execution = await prepareRtkExecution(command, options?.signal, options?.sessionId);
  return shellExec({
    command: execution.command,
    requestedCommand: command,
    env: execution.env,
    onSpawn: execution.onSpawn,
    cwd,
    timeoutMs,
    signal: options?.signal,
    onOutput: options?.onOutput,
    interactiveStdin: getAllowInteractiveStdinInherit() ? "auto" : false,
  });
}

export const toolRegistry_SHELL_1: Record<string, ToolHandler> = {
  async "shell.exec"(args, options) {
    const command = requireString(args, "command");
    const requestedTimeoutMs = optionalNumber(args, "timeoutMs");
    if (
      requestedTimeoutMs !== undefined &&
      (!Number.isInteger(requestedTimeoutMs) || requestedTimeoutMs < 1_000 || requestedTimeoutMs > 1_800_000)
    ) {
      return {
        ok: false,
        exitCode: 1,
        output: "timeoutMs must be an integer from 1000 to 1800000 milliseconds.",
      };
    }
    const launch = resolveShellJobLaunch(args);
    const cwd = optionalString(args, "cwd");
    if (launch.kind === "invalid-title") {
      return { ok: false, exitCode: 1, output: SHELL_JOB_TITLE_REQUIRED };
    }
    if (launch.kind === "foreground") {
      return runForegroundShell(command, cwd, requestedTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS, options);
    }
    const job = await startShellJob(command, cwd, launch, options);
    return job.ok && requestedTimeoutMs !== undefined
      ? { ...job, output: `${job.output}\nNote: timeoutMs applies only to foreground shell.exec and is ignored for background jobs.` }
      : job;
  },
};
