import { responderJobOptions } from "./responder-job-options.js";
import { shellExec } from "../shell.js";
import { DEFAULT_SHELL_TIMEOUT_MS } from "../shell/timeout.js";
import { jobManager } from "../jobs.js";
import { resolveShellExecBackgroundPolicy } from "../command-intent.js";
import { prepareRtkExecution } from "../rtk/rewrite.js";
import { type ToolHandler } from "../tool-types.js";
import {
  prepareElevatedBackgroundCommand,
  tryRunElevatedWithoutTty,
} from "../elevated-shell.js";
import {
  getAllowInteractiveStdinInherit,
  looksInteractiveStdin,
} from "../shell.js";
import { optionalNumber, optionalString, requireString } from "./args.js";

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
    const policy = resolveShellExecBackgroundPolicy({
      command,
      background: args.background,
      responder: args.responder,
    });
    const { wantsBackground, responder } = policy;
    const cwd = optionalString(args, "cwd");
    if (wantsBackground) {
      const elevated = await prepareElevatedBackgroundCommand(command, {
        cwd,
        signal: options?.signal,
        onOutput: options?.onOutput,
        requestSecret: options?.requestSecret,
      });
      if (elevated && !elevated.prepared) return elevated.result;
      const job = await jobManager.startJob(
        elevated?.prepared ? elevated.spec : command,
        {
          cwd,
          name: optionalString(args, "name"),
          ...responderJobOptions(options),
          responder,
          wakeOnCompletion: responder,
        },
      );
      return job.ok && requestedTimeoutMs !== undefined
        ? { ...job, output: `${job.output}\nNote: timeoutMs applies only to foreground shell.exec and is ignored for background jobs.` }
        : job;
    }
    const timeoutMs = requestedTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;

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

    const execution = await prepareRtkExecution(command, options?.signal);
    return shellExec({
      command: execution.command,
      requestedCommand: command,
      env: execution.env,
      cwd: optionalString(args, "cwd"),
      timeoutMs,
      signal: options?.signal,
      onOutput: options?.onOutput,
      interactiveStdin: getAllowInteractiveStdinInherit() ? "auto" : false,
    });
  },
};
