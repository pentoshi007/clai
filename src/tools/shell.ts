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
  /** Max bytes of output to retain in memory for the model (head+tail). */
  maxModelBytes?: number | undefined;
  /** Max bytes streamed to the artifact file before the child is terminated. */
  maxCaptureBytes?: number | undefined;
  /** Behavior when maxCaptureBytes is exceeded. Defaults to "terminate". */
  onLimit?: "terminate" | "continue" | undefined;
  /** Where to save the raw artifact. When undefined, the active session temp dir (or ~/.clai/outputs) is used. */
  artifactPath?: string | undefined;
  /** When true, do not allocate an artifact file (used by tests / dry runs). */
  noArtifact?: boolean | undefined;
  /**
   * Force the child to inherit the parent's stdin so interactive
   * password prompts (sudo, ssh, gpg, doas) can read from the controlling
   * TTY. Defaults to `auto`: enabled for commands {@link looksInteractiveStdin}
   * detects when stdin is a TTY; disabled otherwise. Set explicitly to
   * `true` to force-inherit, `false` to keep stdin closed.
   */
  interactiveStdin?: boolean | "auto" | undefined;
}

/** Prefer the platform default shell, but tolerate minimal sandboxes that omit it. */
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

/** Disable/enable TTY stdin inheritance for password prompts. */
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

/**
 * Run a foreground shell command. A launch-level ENOENT can be transient on
 * macOS even when /bin/sh and cwd both exist. Because the child never started,
 * one runtime-owned retry is safe and avoids teaching the model to mutate the
 * command repeatedly. Command failures after a successful spawn are never
 * retried here.
 */
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
