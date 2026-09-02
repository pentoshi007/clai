import type { ToolResult } from "../types.js";
import type { ToolRunOptions } from "./tool-types.js";
import { spawnArgv } from "./shell.js";


export const SUDO_SESSION_TTL_MS = 5 * 60_000;

export function formatSudoStdinPassword(password: string): string {
  return `${password.replace(/[\r\n]+$/g, "")}\n`;
}

export type SudoAuthOutcome =
  | {
      readonly status: "granted";
      readonly password: string;
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
  void task.finally(() => {
    if (inFlightAuth === task) inFlightAuth = undefined;
  });
  return task;
}

export function looksLikeSudoAuthError(output: string): boolean {
  return /(?:sorry, try again|incorrect password|authentication failure|sudo: \d+ incorrect password)/i.test(
    output,
  );
}

export function evictSudoSession(expected?: string): void {
  if (expected === undefined || cachedPassword?.value === expected) {
    cachedPassword = undefined;
  }
}

export function resetSudoSession(): void {
  cachedPassword = undefined;
  inFlightAuth = undefined;
}
