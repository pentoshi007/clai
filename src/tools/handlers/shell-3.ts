import { responderJobOptions } from "./responder-job-options.js";
import { safeCwd } from "../../os/cwd.js";
import { jobManager, type StartJobOptions } from "../jobs.js";
import { resolveShellExecBackgroundPolicy } from "../command-intent.js";
import { type ToolRunOptions, type ToolHandler } from "../tool-types.js";
import {
  prepareElevatedBackgroundCommand,
  tryRunElevatedWithoutTty,
} from "../elevated-shell.js";
import {
  optionalBoolean,
  optionalNumber,
  optionalResponseMode,
  optionalString,
  requireNumber,
  requireString,
  requireStringAllowEmpty,
} from "./args.js";

export const toolRegistry_SHELL_3: Record<string, ToolHandler> = {
  async "shell.start"(args, options) {
    const command = requireString(args, "command");
    const elevated = await prepareElevatedBackgroundCommand(command, {
      signal: options?.signal,
      onOutput: options?.onOutput,
      requestSecret: options?.requestSecret,
    });
    if (elevated && !elevated.prepared) return elevated.result;
    return jobManager.startJob(elevated?.prepared ? elevated.spec : command, {
      cwd: optionalString(args, "cwd"),
      name: optionalString(args, "name"),
      ...responderJobOptions(options),
      responder: false,
      wakeOnCompletion: false,
    });
  },
  async "shell.jobs"(_args, options) {
    return jobManager.listJobs(options?.sessionId);
  },
  async "shell.tail"(args) {
    const offset = optionalNumber(args, "offset");
    const bytes = optionalNumber(args, "bytes");
    const stream = optionalString(args, "stream") as
      "stdout" | "stderr" | "combined" | undefined;
    return jobManager.tailJob(requireString(args, "id"), {
      ...(offset !== undefined ? { offset } : {}),
      ...(bytes !== undefined ? { bytes } : {}),
      ...(stream !== undefined ? { stream } : {}),
    });
  },
  async "shell.stop"(args) {
    return jobManager.stopJob(requireString(args, "id"));
  },
  async "shell.wait"(args, options) {
    const timeoutMs = optionalNumber(args, "timeoutMs");
    return jobManager.waitForJob(requireString(args, "id"), {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
  },
};
