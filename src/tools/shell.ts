import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "../types.js";
import { OutputDecoder, RingBuffer } from "./shell/capture.js";
import {
  ShellExecAttemptResult,
  shellExecAttempt,
} from "./shell/exec-attempt.js";
import { allowInteractiveStdinInherit, assignAllowInteractiveStdinInherit } from "./shell/internals.js";

export { spawnArgv } from "./shell/spawn-argv.js";
export type { SpawnArgvArgs } from "./shell/spawn-argv.js";
export { OutputDecoder, RingBuffer };

export interface ShellExecArgs {
  command: string;
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
  maxModelBytes?: number | undefined;
  maxCaptureBytes?: number | undefined;
  onLimit?: "terminate" | "continue" | undefined;
  artifactPath?: string | undefined;
  noArtifact?: boolean | undefined;
  interactiveStdin?: boolean | "auto" | undefined;
}

export function resolveShell(): string | undefined {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  const candidates = ["/bin/sh", process.env.SHELL, "/bin/bash", "/bin/zsh"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function withoutLaunchMetadata(result: ShellExecAttemptResult): ToolResult {
  const { launchFailure: _launchFailure, ...publicResult } = result;
  return publicResult;
}

export function setAllowInteractiveStdinInherit(allow: boolean): void {
  assignAllowInteractiveStdinInherit(allow);
}

export function getAllowInteractiveStdinInherit(): boolean {
  return allowInteractiveStdinInherit;
}

export type InteractiveStdinKind = "elevate" | "tty";

export function interactiveStdinKind(
  command: string,
): InteractiveStdinKind | undefined {
  if (typeof command !== "string" || command.length === 0) return undefined;

  const segments = command
    .split(/\s*(?:\|\||&&|;|\|)\s*/g)
    .map((s) => s.trim())
    .filter(Boolean);

  let tty = false;

  for (const segment of segments) {
    const tokens = segment.split(/\s+/);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][\w]*=.*$/.test(tokens[i]!)) i += 1;
    if (
      i < tokens.length &&
      (tokens[i] === "command" || tokens[i] === "exec" || tokens[i] === "time")
    ) {
      i += 1;
    }
    const head = tokens[i];
    if (!head) continue;
    const base = head.replace(/^.*[\\\/]/, "").toLowerCase();
    const rest = tokens.slice(i + 1);
    const restJoined = rest.join(" ");

    if (base === "sudo" || base === "doas" || base === "su") {
      if (
        rest.includes("-n") ||
        rest.includes("--non-interactive") ||
        rest.includes("-S") ||
        rest.includes("--stdin")
      ) {
        continue;
      }
      return "elevate";
    }

    if (base === "ssh" || base === "scp" || base === "rsync") {
      if (/-o\s+batchmode=yes/i.test(restJoined)) continue;
      tty = true;
      continue;
    }

    if (
      base === "gpg" ||
      base === "passwd" ||
      base === "gsudo" ||
      base === "runas"
    ) {
      tty = true;
    }
  }

  return tty ? "tty" : undefined;
}

export function looksInteractiveStdin(command: string): boolean {
  return interactiveStdinKind(command) !== undefined;
}

export async function shellExec(args: ShellExecArgs): Promise<ToolResult> {
  const first = await shellExecAttempt(args);
  const launch = first.launchFailure;
  const retryable =
    launch?.code === "ENOENT" &&
    existsSync(launch.shell) &&
    existsSync(launch.cwd) &&
    args.signal?.aborted !== true &&
    args.artifactPath === undefined;
  if (!retryable) return withoutLaunchMetadata(first);

  await new Promise((resolve) => setTimeout(resolve, 75));
  const second = await shellExecAttempt(args);
  const result = withoutLaunchMetadata(second);
  return {
    ...result,
    output: second.launchFailure
      ? `Automatic retry after a transient command-launch ENOENT also failed.\n${result.output}`
      : `Recovered automatically from one transient command-launch ENOENT.\n${result.output}`.trimEnd(),
  };
}
