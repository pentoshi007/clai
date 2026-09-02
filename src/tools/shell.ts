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

export interface InteractiveStdinOptions {
  readonly stdinSupplied?: boolean | undefined;
}

interface ShellCommandSegment {
  readonly text: string;
  readonly stdinFromPipe: boolean;
}

function startsNestedShellExpression(char: string, next: string | undefined): boolean {
  return next === "(" && (char === "$" || char === "<" || char === ">");
}

function shellCommandSegments(command: string): ShellCommandSegment[] {
  const segments: ShellCommandSegment[] = [];
  let text = "";
  let quote: "'" | '"' | "`" | undefined;
  let nestedDepth = 0;
  let stdinFromPipe = false;

  const push = (nextFromPipe: boolean): void => {
    const trimmed = text.trim();
    if (trimmed) segments.push({ text: trimmed, stdinFromPipe });
    text = "";
    stdinFromPipe = nextFromPipe;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];

    if (quote) {
      text += char;
      if (quote !== "'" && char === "\\" && next !== undefined) {
        text += next;
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      text += char;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      text += `${char}${next}`;
      i += 1;
      continue;
    }
    if (startsNestedShellExpression(char, next)) {
      text += `${char}${next}`;
      nestedDepth += 1;
      i += 1;
      continue;
    }
    if (nestedDepth > 0) {
      text += char;
      if (char === "(") nestedDepth += 1;
      else if (char === ")") nestedDepth -= 1;
      continue;
    }
    if (char === "|" && text.endsWith(">")) {
      text += char;
      continue;
    }
    if (char === "|") {
      if (next === "|") {
        push(false);
        i += 1;
      } else {
        push(true);
        if (next === "&") i += 1;
      }
      continue;
    }
    if (char === "&" && next === "&") {
      push(false);
      i += 1;
      continue;
    }
    if (
      char === "&" &&
      next !== ">" &&
      text.at(-1) !== "<" &&
      text.at(-1) !== ">"
    ) {
      push(false);
      continue;
    }
    if (char === ";" || char === "\n") {
      push(false);
      continue;
    }
    text += char;
  }

  push(false);
  return segments;
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | "`" | undefined;
  let nestedDepth = 0;

  const push = (): void => {
    if (word) words.push(word);
    word = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (quote !== "'" && char === "\\" && next !== undefined) {
        word += next;
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      word += next;
      i += 1;
      continue;
    }
    if (startsNestedShellExpression(char, next)) {
      word += `${char}${next}`;
      nestedDepth += 1;
      i += 1;
      continue;
    }
    if (nestedDepth > 0) {
      word += char;
      if (char === "(") nestedDepth += 1;
      else if (char === ")") nestedDepth -= 1;
      continue;
    }
    if (/\s/.test(char) || char === "(" || char === ")") {
      push();
      continue;
    }
    word += char;
  }

  push();
  return words;
}

const COMMAND_WRAPPERS = new Set(["command", "exec", "time", "env", "nohup", "stdbuf"]);
const WRAPPER_OPTIONS_WITH_VALUE = new Map<string, ReadonlySet<string>>([
  ["env", new Set(["-u", "--unset"])],
  ["stdbuf", new Set(["-i", "-o", "-e", "--input", "--output", "--error"])],
]);

const ENVIRONMENT_ASSIGNMENT = /^[A-Za-z_][\w]*=/;

function skipWrapperOptions(
  tokens: readonly string[],
  from: number,
  wrapper: string,
): number {
  const takesValue = WRAPPER_OPTIONS_WITH_VALUE.get(wrapper);
  let index = from;
  while (index < tokens.length) {
    const option = tokens[index]!;
    if (option === "--") return index + 1;
    if (ENVIRONMENT_ASSIGNMENT.test(option)) {
      index += 1;
      continue;
    }
    if (!option.startsWith("-") || option === "-") return index;
    index += 1;
    if (takesValue?.has(option)) index += 1;
  }
  return index;
}

function commandHeadIndex(tokens: readonly string[]): number {
  let index = 0;
  while (index < tokens.length) {
    while (index < tokens.length && ENVIRONMENT_ASSIGNMENT.test(tokens[index]!)) {
      index += 1;
    }
    const candidate = tokens[index];
    if (candidate === undefined) break;
    const wrapper = candidate.replace(/^.*[\\\/]/, "").toLowerCase();
    if (!COMMAND_WRAPPERS.has(wrapper)) break;
    index = skipWrapperOptions(tokens, index + 1, wrapper);
  }
  return index;
}

function hasStdinRedirection(command: string): boolean {
  let quote: "'" | '"' | "`" | undefined;
  let nestedDepth = 0;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];
    if (quote) {
      if (quote !== "'" && char === "\\" && next !== undefined) {
        i += 1;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "\\" && next !== undefined) {
      i += 1;
      continue;
    }
    if (startsNestedShellExpression(char, next)) {
      nestedDepth += 1;
      i += 1;
      continue;
    }
    if (nestedDepth > 0) {
      if (char === "(") nestedDepth += 1;
      else if (char === ")") nestedDepth -= 1;
      continue;
    }
    if (char !== "<") continue;

    let digitStart = i;
    while (digitStart > 0 && /\d/.test(command[digitStart - 1]!)) {
      digitStart -= 1;
    }
    const descriptor = command.slice(digitStart, i);
    if (descriptor && descriptor !== "0") continue;
    return true;
  }
  return false;
}

const ELEVATION_LONG_OPTIONS_WITH_VALUE = new Set([
  "--chdir",
  "--chroot",
  "--close-from",
  "--command-timeout",
  "--group",
  "--host",
  "--other-user",
  "--prompt",
  "--role",
  "--type",
  "--user",
]);
const ELEVATION_SHORT_OPTIONS_WITH_VALUE = new Set([
  "C",
  "D",
  "g",
  "h",
  "p",
  "R",
  "T",
  "U",
  "u",
]);

function elevationInputFlags(
  base: string,
  args: readonly string[],
): { readonly nonInteractive: boolean; readonly readsStdin: boolean } {
  if (base === "su") return { nonInteractive: false, readsStdin: false };
  let nonInteractive = false;
  let readsStdin = false;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === "--") break;
    if (!token.startsWith("-") || token === "-") break;
    if (token.startsWith("--")) {
      const separator = token.indexOf("=");
      const name = separator >= 0 ? token.slice(0, separator) : token;
      if (name === "--non-interactive") nonInteractive = true;
      if (base === "sudo" && name === "--stdin") readsStdin = true;
      if (separator < 0 && ELEVATION_LONG_OPTIONS_WITH_VALUE.has(name)) i += 1;
      continue;
    }

    const cluster = token.slice(1);
    for (let j = 0; j < cluster.length; j += 1) {
      const flag = cluster[j]!;
      if (flag === "n") nonInteractive = true;
      if (base === "sudo" && flag === "S") readsStdin = true;
      if (ELEVATION_SHORT_OPTIONS_WITH_VALUE.has(flag)) {
        if (j === cluster.length - 1) i += 1;
        break;
      }
    }
  }

  return { nonInteractive, readsStdin };
}

export function interactiveStdinKind(
  command: string,
  options: InteractiveStdinOptions = {},
): InteractiveStdinKind | undefined {
  if (typeof command !== "string" || command.length === 0) return undefined;

  const segments = shellCommandSegments(command);
  let tty = false;

  for (const segment of segments) {
    const tokens = shellWords(segment.text);
    const i = commandHeadIndex(tokens);
    const head = tokens[i];
    if (!head) continue;
    const base = head.replace(/^.*[\\\/]/, "").toLowerCase();
    const rest = tokens.slice(i + 1);
    const restJoined = rest.join(" ");

    if (base === "sudo" || base === "doas" || base === "su") {
      const flags = elevationInputFlags(base, rest);
      if (flags.nonInteractive) continue;
      const stdinSupplied =
        options.stdinSupplied === true ||
        segment.stdinFromPipe ||
        hasStdinRedirection(segment.text);
      if (flags.readsStdin && stdinSupplied) continue;
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

export function looksInteractiveStdin(
  command: string,
  options?: InteractiveStdinOptions,
): boolean {
  return interactiveStdinKind(command, options) !== undefined;
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
