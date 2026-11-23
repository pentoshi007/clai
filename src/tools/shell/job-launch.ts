import { resolveShellExecBackgroundPolicy } from "../command-intent.js";
import { JOB_TITLE_LIMIT, normalizeJobTitle } from "../jobs/title.js";

export const SHELL_JOB_TITLE_REQUIRED =
  `Background and Responder jobs require a short "name" (1–${JOB_TITLE_LIMIT} characters) describing the work, not the command. The command did not start.`;

type ShellJobLaunch =
  | { kind: "foreground" }
  | { kind: "invalid-title" }
  | { kind: "background"; name: string; responder: boolean };

export function resolveShellJobLaunch(args: Readonly<Record<string, unknown>>): ShellJobLaunch {
  const { command, background, responder } = args;
  if (typeof command !== "string" || !command) return { kind: "foreground" };
  const policy = resolveShellExecBackgroundPolicy({ command, background, responder });
  if (!policy.wantsBackground) return { kind: "foreground" };
  const name = normalizeJobTitle(args.name, command);
  return name ? { kind: "background", name, responder: policy.responder } : { kind: "invalid-title" };
}
