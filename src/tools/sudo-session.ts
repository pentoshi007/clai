import type { ToolResult } from "../types.js";
import type { ToolRunOptions } from "./tool-types.js";
import { spawnArgv } from "./shell.js";

/**
 * Shared sudo authentication for every privileged tool path (nmap stealth
 * scans, elevated shell commands, privileged background jobs).
 *
 * Why this exists: tool calls in one assistant turn run concurrently, and
 * every UI (classic + OpenTUI) routes the secure password prompt through a
 * single blocking overlay. Without coordination, two parallel `net.scan`
 * calls both ask for the sudo password at the same moment — the first
 * request opens the modal, the second is refused by the busy overlay and
 * reports "sudo cancelled", silently downgrading that scan to an
 * unprivileged TCP connect scan.
 *
 * Two mechanisms fix it:
 *   1. Coalescing — while one password prompt is open, every other caller
 *      awaits the same in-flight request instead of prompting again. One
 *      password entry authorizes the whole parallel batch.
 *   2. A short-lived in-memory cache (mirroring sudo's own 5-minute
 *      timestamp_timeout) — privileged commands that start just after a
 *      successful authentication reuse the password instead of re-prompting.
 *
 * The password is only ever piped to `sudo -S` over child stdin. It is never
 * written to disk, artifacts, or logs, and it is dropped when the TTL
 * expires or {@link evictSudoSession} reports it stopped working.
 */

/** Mirrors sudo's default timestamp_timeout (5 minutes). */
export const SUDO_SESSION_TTL_MS = 5 * 60_000;

export function formatSudoStdinPassword(password: string): string {
  return `${password.replace(/[\r\n]+$/g, "")}\n`;
}

export type SudoAuthOutcome =
  | {
      readonly status: "granted";
      readonly password: string;
      /** True when the password came from the in-memory cache (no prompt shown). */
      readonly fromCache: boolean;
    }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly detail: string };

export interface SudoAuthOptions {
  readonly requestSecret: (
    request: { title: string; prompt: string },
  ) => Promise<string | undefined>;
  readonly title: string;
  readonly prompt: string;
  readonly signal?: AbortSignal | undefined;
  readonly onOutput?: ToolRunOptions["onOutput"];
}

export interface SudoAuthDependencies {
  /** Test seam for the `sudo -v` validation spawn. */
  readonly runAuth?: ((args: {
    command: string;
    argv: string[];
    stdinText?: string | undefined;
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    onOutput?: ToolRunOptions["onOutput"];
    noArtifact?: boolean | undefined;
    interactiveStdin?: boolean | "auto" | undefined;
  }) => Promise<ToolResult>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly ttlMs?: number | undefined;
}

let cachedPassword: { value: string; expiresAt: number } | undefined;
let inFlightAuth: Promise<SudoAuthOutcome> | undefined;

export function obtainSudoPassword(
  options: SudoAuthOptions,
  dependencies: SudoAuthDependencies = {},
): Promise<SudoAuthOutcome> {
  const now = dependencies.now ?? (() => Date.now());
  const ttlMs = dependencies.ttlMs ?? SUDO_SESSION_TTL_MS;

  if (cachedPassword && now() < cachedPassword.expiresAt) {
    return Promise.resolve({
      status: "granted",
      password: cachedPassword.value,
      fromCache: true,
    });
  }
  // A prompt is already open in some other parallel tool call — share its
  // outcome instead of asking the user for the same password twice (the
  // second request would be refused by the single-blocking-overlay UI).
  if (inFlightAuth) return inFlightAuth;

  const task = (async (): Promise<SudoAuthOutcome> => {
    const password = await options.requestSecret({
      title: options.title,
      prompt: options.prompt,
    });
    if (password === undefined || options.signal?.aborted) {
      return { status: "cancelled" };
    }
    const stdinText = formatSudoStdinPassword(password);
    const runAuth = dependencies.runAuth ?? spawnArgv;
    let auth: ToolResult;
    try {
      auth = await runAuth({
        command: "sudo",
        argv: ["-S", "-p", "", "-v"],
        stdinText,
        timeoutMs: 30_000,
        signal: options.signal,
        onOutput: options.onOutput,
        noArtifact: true,
        interactiveStdin: false,
      });
    } catch (error) {
      return {
        status: "failed",
        detail: `sudo authentication could not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
    if (options.signal?.aborted || auth.exitCode === 130) {
      return { status: "cancelled" };
    }
    if (!auth.ok) {
      return {
        status: "failed",
        detail: (auth.output ?? "").trim().slice(0, 400),
      };
    }
    cachedPassword = { value: password, expiresAt: now() + ttlMs };
    return { status: "granted", password, fromCache: false };
  })();

  inFlightAuth = task;
  // The task never rejects (all paths return an outcome), so this cannot
  // produce an unhandled rejection.
  void task.finally(() => {
    if (inFlightAuth === task) inFlightAuth = undefined;
  });
  return task;
}

/**
 * Did a privileged child fail because the sudo password itself was rejected?
 * Deliberately narrower than generic privilege-detection: nmap's own
 * "requires root privileges" does not mean the password is wrong, only
 * sudo's authentication failures do.
 */
export function looksLikeSudoAuthError(output: string): boolean {
  return /(?:sorry, try again|incorrect password|authentication failure|sudo: \d+ incorrect password)/i.test(
    output,
  );
}

/**
 * Drop the cached password. Callers invoke this when a `sudo -S` run using
 * the cached password was rejected (e.g. the password changed mid-session),
 * so the next privileged operation prompts again instead of replaying a
 * stale secret. When `expected` is given, the cache is only cleared if it
 * still holds that exact password.
 */
export function evictSudoSession(expected?: string): void {
  if (expected === undefined || cachedPassword?.value === expected) {
    cachedPassword = undefined;
  }
}

/** Test hook: clear the cached password and forget any in-flight prompt. */
export function resetSudoSession(): void {
  cachedPassword = undefined;
  inFlightAuth = undefined;
}
