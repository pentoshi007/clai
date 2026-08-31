import { responderJobOptions } from "./responder-job-options.js";
import { safeCwd } from "../../os/cwd.js";
import { shellExec, spawnArgv } from "../shell.js";
import {
  isLongQuietInstallOrScaffoldCommand,
  isLongRunningTestOrBuildCommand,
} from "../../agent/task-evidence.js";
import { jobManager, type StartJobOptions } from "../jobs.js";
import { resolveShellExecBackgroundPolicy } from "../command-intent.js";
import { type ToolRunOptions, type ToolHandler } from "../tool-types.js";
import {
  prepareElevatedBackgroundCommand,
  tryRunElevatedWithoutTty,
} from "../elevated-shell.js";
import {
  getAllowInteractiveStdinInherit,
  looksInteractiveStdin,
} from "../shell.js";
import {
  compileBatchFailMode,
  evaluateCancelTargets,
  formatBatchCancelReason,
  parseBatchFailPolicy,
} from "../batch-fail-policy.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalResponseMode,
  optionalString,
  requireNumber,
  requireString,
  requireStringAllowEmpty,
} from "./args.js";

export const toolRegistry_SHELL_1: Record<string, ToolHandler> = {
  async "shell.exec"(args, options) {
    const command = requireString(args, "command");
    const requestedTimeoutMs = optionalNumber(args, "timeoutMs");
    const policy = resolveShellExecBackgroundPolicy({
      command,
      background: args.background,
      responder: args.responder,
    });
    const { backgroundMode, costReason, wantsBackground, responder } = policy;
    if (wantsBackground) {
      const elevated = await prepareElevatedBackgroundCommand(command, {
        signal: options?.signal,
        onOutput: options?.onOutput,
        requestSecret: options?.requestSecret,
      });
      if (elevated && !elevated.prepared) return elevated.result;
      const job = await jobManager.startJob(
        elevated?.prepared ? elevated.spec : command,
        {
          cwd: optionalString(args, "cwd"),
          ...responderJobOptions(options),
          responder,
          wakeOnCompletion: responder,
        },
      );
      if (job.ok) {
        const autoBackgrounded = backgroundMode === "auto";
        const timeoutNote =
          autoBackgrounded && requestedTimeoutMs !== undefined
            ? `\n\nNote: timeoutMs=${requestedTimeoutMs} does not apply — this command was auto-backgrounded${costReason ? ` (${costReason})` : ""}. Pass background:"never" to run it in the foreground with your timeout.`
            : "";
        const costNote =
          autoBackgrounded && costReason
            ? `\n\nAuto-backgrounded because: ${costReason}. Pass background:"never" to force foreground.`
            : "";
        return {
          ...job,
          output: `${job.output}${costNote}${timeoutNote}`,
        };
      }
      return job;
    }
    let timeoutMs = requestedTimeoutMs;
    // Handle seconds vs milliseconds confusion for long-running commands
    // If model sends 300 thinking 300s, but code expects ms, convert small values to ms
    if (
      timeoutMs !== undefined &&
      timeoutMs > 0 &&
      timeoutMs < 1000 &&
      (isLongQuietInstallOrScaffoldCommand(command) ||
        isLongRunningTestOrBuildCommand(command))
    ) {
      timeoutMs = timeoutMs * 1000;
    }
    timeoutMs =
      timeoutMs ??
      (isLongQuietInstallOrScaffoldCommand(command)
        ? 15 * 60_000
        : isLongRunningTestOrBuildCommand(command)
          ? 120_000
          : undefined);

    // Password tools must never steal the TTY in OpenTUI (freezes Esc/clicks).
    // Prefer secure modal + sudo -S; otherwise refuse interactive elevation.
    if (looksInteractiveStdin(command)) {
      const elevated = await tryRunElevatedWithoutTty(command, {
        cwd: optionalString(args, "cwd"),
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

    return shellExec({
      command,
      cwd: optionalString(args, "cwd"),
      timeoutMs,
      signal: options?.signal,
      onOutput: options?.onOutput,
      // Explicit: never inherit unless classic REPL policy allows it.
      interactiveStdin: getAllowInteractiveStdinInherit() ? "auto" : false,
    });
  },
};
