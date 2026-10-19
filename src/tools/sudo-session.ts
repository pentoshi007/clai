import type { ToolCall, ToolResult } from "../types.js";
import type { SecretPort } from "../app/ports/secret-port.js";
import type { ToolRunOptions } from "./tool-types.js";
import { spawnArgv } from "./shell.js";
import { getMachineSudoPassword } from "../store/credentials.js";
import { registerKnownSecret, redactKnownSecrets } from "../security/known-secrets.js";


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
  readonly requestSecret?: SecretPort["request"] | undefined;
  readonly operation?: ToolCall | undefined;
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
  readonly getStoredPassword?: (() => Promise<string | undefined>) | undefined;
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
    if (options.signal?.aborted) return { status: "cancelled" };
    let stored: string | undefined;
    let password: string | undefined;
    try {
      stored = await (dependencies.getStoredPassword ?? getMachineSudoPassword)();
      if (stored === undefined && !options.requestSecret) {
        return { status: "failed", detail: "No machine sudo credential or secure password prompt is available. Configure /creds or use an interactive terminal." };
      }
      password = stored ?? await options.requestSecret?.({
        title: options.title,
        prompt: options.prompt,
        operation: options.operation,
      });
    } catch {
      return { status: "failed", detail: "The machine credential could not be unlocked. Check /creds; no password prompt was opened." };
    }
    if (password === undefined || options.signal?.aborted) {
      return { status: "cancelled" };
    }
    registerKnownSecret(password);
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
        detail: redactKnownSecrets(`sudo authentication could not start: ${
          error instanceof Error ? error.message : String(error)
        }`),
      };
    }
    if (options.signal?.aborted || auth.exitCode === 130) {
      return { status: "cancelled" };
    }
    if (!auth.ok) {
      return {
        status: "failed",
        detail: `${stored !== undefined ? "Stored machine sudo password was rejected; update or remove it in /creds. " : ""}${redactKnownSecrets(auth.output ?? "").trim().slice(0, 400)}`,
      };
    }
    cachedPassword = { value: password, expiresAt: now() + ttlMs };
    return { status: "granted", password, fromCache: false };
  })();

  inFlightAuth = task;
  const clear = (): void => {
    if (inFlightAuth === task) inFlightAuth = undefined;
  };
  void task.then(clear, clear);
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
