import { spawn } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolResult, ToolStats } from "../types.js";
import { redactSecrets } from "../llm/provider.js";
import { safeCwd } from "../os/cwd.js";
import { getArtifactDir } from "../store/paths.js";
import { augmentedPathEnv } from "../os/command.js";
import { terminateProcessTree } from "../os/process-tree.js";

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

export interface SpawnArgvArgs {
  command: string;
  argv: string[];
  cwd?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  onOutput?: ((chunk: string, stream: "stdout" | "stderr") => void) | undefined;
  maxModelBytes?: number | undefined;
  maxCaptureBytes?: number | undefined;
  onLimit?: "terminate" | "continue" | undefined;
  artifactPath?: string | undefined;
  noArtifact?: boolean | undefined;
  /** Sensitive stdin payload written directly to the child and never logged. */
  stdinText?: string | undefined;
  /** See {@link ShellExecArgs.interactiveStdin}. */
  interactiveStdin?: boolean | "auto" | undefined;
}

const DEFAULT_MAX_MODEL_BYTES = 12_000;
const DEFAULT_MAX_CAPTURE_BYTES = 500 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 40_000;

/** Prefer the platform default shell, but tolerate minimal sandboxes that omit it. */
export function resolveShell(): string | undefined {
  if (process.platform === "win32") return process.env.ComSpec ?? "cmd.exe";
  const candidates = ["/bin/sh", process.env.SHELL, "/bin/bash", "/bin/zsh"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function launchErrorOutput(
  error: NodeJS.ErrnoException,
  details: { shell: string; cwd: string },
): string {
  const code = error.code ?? "UNKNOWN";
  const fields = [
    `shell=${JSON.stringify(details.shell)}`,
    `cwd=${JSON.stringify(details.cwd)}`,
    error.syscall ? `syscall=${JSON.stringify(error.syscall)}` : undefined,
    error.path ? `path=${JSON.stringify(error.path)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return (
    `Command launch error [${code}]: ${error.message}\n` +
    `${fields.join("; ")}\n` +
    "The command did not start. Do not rewrite its syntax to work around this infrastructure error; verify the shell and cwd, then retry at most once."
  );
}

interface ShellExecAttemptResult extends ToolResult {
  /** Internal-only metadata used to safely retry a command that never started. */
  launchFailure?: {
    code?: string | undefined;
    shell: string;
    cwd: string;
  } | undefined;
}

function withoutLaunchMetadata(result: ShellExecAttemptResult): ToolResult {
  const { launchFailure: _launchFailure, ...publicResult } = result;
  return publicResult;
}

/**
 * When false, children never inherit process.stdin (no TTY password prompts).
 * OpenTUI sets this false at startup — inheriting stdin freezes the TUI
 * (Esc/Ctrl+C/clicks die; raw "Password:" leaks under the composer).
 * Defaults to false for every frontend: privileged commands must use the
 * managed SecretPort path and may never take over process.stdin.
 */
let allowInteractiveStdinInherit = false;

/** Disable/enable TTY stdin inheritance for password prompts. */
export function setAllowInteractiveStdinInherit(allow: boolean): void {
  allowInteractiveStdinInherit = allow;
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

/**
 * Compose the `stdio` array for {@link spawn} based on whether the
 * caller requested an interactive stdin and whether the parent has
 * one to give. Falls back to `"ignore"` whenever the parent is not
 * connected to a TTY (CI runs, piped invocations, tests) so a missing
 * controlling terminal can never wedge the child waiting on input.
 */
function chooseStdio(
  command: string,
  preference: boolean | "auto" | undefined,
): ["ignore" | "inherit", "pipe", "pipe"] {
  // Hard ban: TUI and other hosts that cannot survive stdin takeover.
  if (!allowInteractiveStdinInherit) return ["ignore", "pipe", "pipe"];
  if (preference === false) return ["ignore", "pipe", "pipe"];
  const wantInteractive =
    preference === true ||
    ((preference === "auto" || preference === undefined) &&
      looksInteractiveStdin(command));
  if (!wantInteractive) return ["ignore", "pipe", "pipe"];
  if (process.stdin.isTTY) return ["inherit", "pipe", "pipe"];
  return ["ignore", "pipe", "pipe"];
}

/**
 * Capture stdin's current `isRaw` state and switch it to cooked mode so
 * an interactive child (sudo, ssh) can read a password line through the
 * inherited stdin. Returns an idempotent restore used from every exit path.
 */
function takeOverCookedStdin(): () => void {
  if (!process.stdin.isTTY) return () => {};
  const stream = process.stdin as NodeJS.ReadStream & { isRaw?: boolean };
  const wasRaw = Boolean(stream.isRaw);
  try {
    if (wasRaw) stream.setRawMode(false);
    process.stdin.pause();
  } catch {
    /* ignore */
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      if (process.stdin.isTTY) {
        if (wasRaw) stream.setRawMode(true);
      }
    } catch {
      /* ignore */
    }
    try {
      process.stdin.resume();
    } catch {
      /* ignore */
    }
  };
}

function safeArtifactName(command: string): string {
  const head = command.trim().split(/\s+/)[0] ?? "shell";
  const clean = head.replace(/[^a-z0-9_.-]+/gi, "-").replace(/^-+|-+$/g, "");
  return clean || "shell";
}

async function openArtifact(
  command: string,
  override?: string,
): Promise<
  | {
      path: string;
      stream: WriteStream;
    }
  | undefined
> {
  try {
    const dir = override
      ? join(override, "..")
      : getArtifactDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path =
      override ??
      join(
        dir,
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeArtifactName(command)}.txt`,
      );
    // Command transcripts routinely contain tokens, target data, and env
    // dumps — never leave them world-readable on a multi-user box.
    const stream = createWriteStream(path, { flags: "w", mode: 0o600 });
    return { path, stream };
  } catch {
    return undefined;
  }
}

/**
 * Streaming UTF-8 decoder with byte accounting and a binary sniff.
 *
 * `chunk.toString()` per chunk splits multi-byte characters at buffer
 * boundaries (mojibake in nmap banners, i18n build logs, unicode filenames),
 * and `text.length` counts UTF-16 code units, so every byte cap was wrong for
 * non-ASCII output. Binary output is detected once and reported so the model
 * gets a marker instead of lossy text.
 * Exported only for tests.
 */
export class OutputDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private sniffed = 0;
  private nonPrintable = 0;
  private binaryDetected = false;

  decode(chunk: Buffer): { text: string; bytes: number } {
    this.sniff(chunk);
    return { text: this.decoder.write(chunk), bytes: chunk.byteLength };
  }

  end(): string {
    return this.decoder.end();
  }

  get isBinary(): boolean {
    return this.binaryDetected;
  }

  private sniff(chunk: Buffer): void {
    if (this.binaryDetected || this.sniffed >= 2_048) return;
    const sample = chunk.subarray(0, 2_048 - this.sniffed);
    for (const byte of sample) {
      if (byte === 0) {
        this.binaryDetected = true;
        return;
      }
      if (byte < 9 || (byte > 13 && byte < 32)) this.nonPrintable += 1;
    }
    this.sniffed += sample.byteLength;
    if (this.sniffed >= 256 && this.nonPrintable / this.sniffed > 0.3) {
      this.binaryDetected = true;
    }
  }
}

/**
 * Model-facing replacement for binary command output. Reporting the size and
 * the artifact path is useful evidence; feeding decoded binary to the model is
 * not, and it wrecks byte accounting downstream.
 */
function binarySuppressionNotice(
  bytes: number,
  artifactPath: string | undefined,
): string {
  return (
    `[binary output suppressed: ${bytes.toLocaleString()} bytes]` +
    (artifactPath
      ? `\nFull bytes were captured to ${artifactPath}. Use a text-producing command (xxd/strings/file) if you need to inspect them.`
      : "\nUse a text-producing command (xxd/strings/file) if you need to inspect the bytes.")
  );
}

/** A small ring buffer of recent output lines used as the "tail" summary.
 *  Exported only for tests. */export class RingBuffer {
  private chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly capacity: number) {}

  push(text: string): void {
    // When a single chunk is larger than our capacity, keep only its
    // tail. Otherwise some platforms (notably Windows, where Node delivers
    // stdout in one big buffer) leave the ring holding far more than
    // capacity bytes and the model-facing summary blows past maxModelBytes.
    if (text.length >= this.capacity) {
      this.chunks = [text.slice(text.length - this.capacity)];
      this.bytes = this.chunks[0]!.length;
      return;
    }
    this.chunks.push(text);
    this.bytes += text.length;
    while (this.bytes > this.capacity && this.chunks.length > 1) {
      const removed = this.chunks.shift()!;
      this.bytes -= removed.length;
    }
    // After shifting all but one chunk we may still be over capacity if
    // the remaining chunk is itself larger than the cap. Trim it down.
    if (this.bytes > this.capacity && this.chunks.length === 1) {
      const only = this.chunks[0]!;
      this.chunks[0] = only.slice(only.length - this.capacity);
      this.bytes = this.chunks[0]!.length;
    }
  }

  toString(): string {
    return this.chunks.join("");
  }

  size(): number {
    return this.bytes;
  }
}

/**
 * Re-read a freshly written artifact, run it through the same redactor
 * the model-facing output uses, and write it back atomically. This is a
 * defense-in-depth measure: live capture is unavoidable byte-by-byte, so
 * we redact post-hoc the moment the child closes, before any reader
 * (user, model, or `/output last`) gets a chance to see the raw bytes.
 *
 * Returns whether the artifact was rewritten. Any error is swallowed — a
 * raw artifact is still better than an inaccessible one, and the model
 * never receives the unredacted content (that path runs through
 * redactSecrets() too).
 */
/** Skip full-file redaction above this size (avoids multi‑hundred‑MB heap spikes). */
const MAX_REDACT_IN_MEMORY_BYTES = 8 * 1024 * 1024;

async function redactArtifactInPlace(path: string): Promise<boolean> {
  try {
    const st = await stat(path);
    if (st.size > MAX_REDACT_IN_MEMORY_BYTES) return false;
    const raw = await readFile(path, "utf8");
    const redacted = redactSecrets(raw);
    if (redacted === raw) return false;
    await writeFile(path, redacted, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

const NO_MATCH_EXIT_COMMANDS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "zgrep",
  "rg",
  "findstr",
  "ack",
  "ag",
  "diff",
  "diff3",
  "cmp",
  "comm",
  "test",
  "[",
]);

function finalPipelineStageName(command: string): string | undefined {
  const lastInChain = command.split(/;|&&|\|\|/).pop() ?? "";
  const lastStage = lastInChain.split("|").pop() ?? "";
  const tokens = lastStage.trim().split(/\s+/).filter(Boolean);
  let index = 0;
  while (
    index < tokens.length &&
    (tokens[index] === "sudo" ||
      tokens[index] === "command" ||
      tokens[index] === "builtin" ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!))
  ) {
    index += 1;
  }
  const first = tokens[index];
  if (!first) return undefined;
  return first.split("/").pop();
}

function benignNoMatchTool(
  command: string,
  code: number | null,
): string | undefined {
  if (code !== 1) return undefined;
  const name = finalPipelineStageName(command);
  return name !== undefined && NO_MATCH_EXIT_COMMANDS.has(name)
    ? name
    : undefined;
}

async function shellExecAttempt(args: ShellExecArgs): Promise<ShellExecAttemptResult> {
  if (args.signal?.aborted) {
    return { ok: false, output: "Command aborted.", exitCode: 130 };
  }

  const cwd = args.cwd ?? safeCwd();
  try {
    const cwdStat = await stat(cwd);
    if (!cwdStat.isDirectory()) {
      return {
        ok: false,
        output:
          `Command launch error [INVALID_CWD]: working directory is not a directory.\n` +
          `cwd=${JSON.stringify(cwd)}\nThe command did not start; correct the shell.exec cwd instead of changing command syntax.`,
        exitCode: 127,
      };
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output:
        `Command launch error [INVALID_CWD]: ${detail}\n` +
        `cwd=${JSON.stringify(cwd)}\nThe command did not start; correct the shell.exec cwd instead of changing command syntax.`,
      exitCode: 127,
    };
  }

  const maxModelBytes = args.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES;
  const maxCaptureBytes = args.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const onLimit = args.onLimit ?? "continue";
  const halfModel = Math.max(512, Math.floor(maxModelBytes / 2));

  const start = Date.now();
  const artifact = args.noArtifact
    ? undefined
    : await openArtifact(args.command, args.artifactPath);

  let head = "";
  const tail = new RingBuffer(halfModel);
  let bytesRead = 0;
  const decoder = new OutputDecoder();
  let bytesDropped = 0;
  let linesRead = 0;
  let captureLimitHit = false;

  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    const stdio = chooseStdio(args.command, args.interactiveStdin);
    const usingInteractiveStdin = stdio[0] === "inherit";
    const restoreStdin = usingInteractiveStdin
      ? takeOverCookedStdin()
      : () => {};
    const shell = resolveShell();
    if (!shell) {
      restoreStdin();
      if (artifact) artifact.stream.end();
      resolve({
        ok: false,
        exitCode: 127,
        output: "No usable command shell was found. shell.exec requires /bin/sh (or $SHELL); use a purpose-built tool where available.",
      });
      return;
    }
    const child = spawn(args.command, {
      cwd,
      detached: detached && !usingInteractiveStdin,
      shell,
      stdio,
      env: { ...process.env, PATH: augmentedPathEnv() },
    });
    let aborted = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      args.signal?.removeEventListener("abort", abort);
      restoreStdin();
      if (artifact) {
        artifact.stream.end();
      }
    };

    const append = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const decoded = decoder.decode(chunk);
      const text = decoded.text;
      bytesRead += decoded.bytes;
      linesRead += text.split("\n").length - 1;
      // Stream raw bytes to the artifact file (cheap; no concat).
      if (artifact && !captureLimitHit) {
        if (bytesRead <= maxCaptureBytes) {
          artifact.stream.write(text);
        } else {
          // Write only the prefix that fits under the cap, then close.
          const overflow = bytesRead - maxCaptureBytes;
          const allowed = text.length - overflow;
          if (allowed > 0) artifact.stream.write(text.slice(0, allowed));
          captureLimitHit = true;
          artifact.stream.end();
        }
      }
      // Maintain head + ring-tail model summary.
      if (head.length < halfModel) {
        const room = halfModel - head.length;
        head += text.slice(0, room);
        if (text.length > room) tail.push(text.slice(room));
      } else {
        tail.push(text);
      }
      // Track bytes we dropped from the in-memory ring buffer for stats.
      const inMemory = head.length + tail.size();
      bytesDropped = Math.max(0, bytesRead - inMemory);
      // Live preview is still sent through onOutput so the UI can dim it.
      args.onOutput?.(text, stream);
      // Optional capture-limit termination.
      if (captureLimitHit && onLimit === "terminate") {
        terminate("cap");
      }
    };

    const killChild = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      // `detached` was disabled when we inherited stdin so the child shares our
      // process group — signal it directly. Otherwise take down the whole tree.
      const useGroup = detached && !usingInteractiveStdin;
      if (!useGroup && process.platform !== "win32") {
        try {
          child.kill(signal);
        } catch {
          // Process may have already exited.
        }
        return;
      }
      terminateProcessTree(child.pid, {
        signal,
        ...(useGroup ? { processGroupId: child.pid } : {}),
      });
    };

    const terminate = (reason: "abort" | "timeout" | "cap"): void => {
      if (reason === "abort") {
        if (aborted) {
          // Second abort attempt — the child ignored SIGTERM; force-kill.
          killChild("SIGKILL");
          return;
        }
        aborted = true;
      }
      if (reason === "timeout") timedOut = true;
      killChild("SIGTERM");
      // Escalate to SIGKILL quickly — some tools (eg ffuf) catch SIGTERM
      // and take several seconds to shut down.
      forceKill = setTimeout(() => killChild("SIGKILL"), 500);
    };

    const abort = (): void => terminate("abort");

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", (error) => {
      cleanup();
      if (aborted || args.signal?.aborted) {
        resolve({ ok: false, output: "Command aborted.", exitCode: 130 });
      } else {
        resolve({
          ok: false,
          exitCode: 127,
          output: launchErrorOutput(error as NodeJS.ErrnoException, {
            shell,
            cwd,
          }),
          launchFailure: {
            code: (error as NodeJS.ErrnoException).code,
            shell,
            cwd,
          },
        });
      }
    });
    child.on("close", (code) => {
      cleanup();
      const stats: ToolStats = {
        bytesRead,
        bytesDropped,
        linesRead,
        elapsedMs: Date.now() - start,
        captureLimitHit,
      };

      const trimmedTail = tail.toString().trim();
      const trimmedHead = head.trim();
      const inMemory = head.length + tail.size();
      let combined: string;
      if (bytesRead === 0) {
        combined = "";
      } else if (inMemory >= bytesRead) {
        // Everything fit in memory; concat head+tail back into one string.
        combined = (head + tail.toString()).trimEnd();
      } else {
        const omittedBytes = bytesRead - inMemory;
        combined =
          `${trimmedHead}\n... (${omittedBytes.toLocaleString()} bytes / ~${linesRead.toLocaleString()} lines truncated — full output in artifact) ...\n${trimmedTail}`.trim();
      }

      // Always redact before exposing the bounded text to callers.
      // Binary output (a stray `cat /bin/ls`, a downloaded tarball) is
      // replaced with a hash + marker instead of lossy mojibake.
      const output = decoder.isBinary
        ? binarySuppressionNotice(bytesRead, artifact?.path)
        : redactSecrets(combined);

      // Redact the on-disk artifact too so `/output last` and any later
      // reader (model, user, audit) sees the same scrubbed bytes.
      const finalize = (result: ToolResult): void => {
        if (artifact) {
          // Wait for the artifact write stream to flush, then redact in
          // place, then resolve. Awaiting matters: tests and downstream
          // readers must never see the unredacted bytes, even briefly.
          const onFlushed = (): void => {
            void redactArtifactInPlace(artifact.path).then(() =>
              resolve(result),
            );
          };
          if ((artifact.stream as WriteStream).writableFinished) {
            onFlushed();
          } else {
            artifact.stream.once("finish", onFlushed);
            artifact.stream.once("error", onFlushed);
          }
        } else {
          resolve(result);
        }
      };

      if (aborted || args.signal?.aborted) {
        finalize({
          ok: false,
          output: output ? `${output}\nCommand aborted.` : "Command aborted.",
          exitCode: 130,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (timedOut) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand timed out.`
            : "Command timed out.",
          exitCode: 124,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (captureLimitHit) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand killed after exceeding capture cap of ${maxCaptureBytes.toLocaleString()} bytes.`
            : "Command exceeded capture cap.",
          exitCode: 137,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: true,
          stats,
        });
        return;
      }
      const noMatchTool = benignNoMatchTool(args.command, code);
      const benignNote = (() => {
        if (!noMatchTool) return undefined;
        if (["diff", "diff3", "cmp", "comm"].includes(noMatchTool)) return `files differ`;
        if (["test", "["].includes(noMatchTool)) return `condition false`;
        return `no matching lines`;
      })();
      finalize({
        ok: code === 0 || noMatchTool !== undefined,
        output: noMatchTool
          ? `${output ? `${output}\n` : ""}[note: exit=1 from ${noMatchTool} (${benignNote}) — not an error]`
          : output,
        exitCode: code ?? undefined,
        ...(artifact ? { outputPath: artifact.path } : {}),
        truncated: bytesRead > inMemory,
        stats,
      });
    });

    args.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(
      () => terminate("timeout"),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  });
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

/**
 * Run a child process with `shell: false`, passing argv directly. Use this
 * for any tool that builds command lines from model-provided strings (eg
 * `net.scan`, `pentest.recon`, `pkg.install`). Sharing argv with the OS
 * shell would let a malicious target turn into "; rm -rf /" — `shell: false`
 * + argv prevents that even if the model is adversarial.
 *
 * The capture pipeline (head + ring-tail + artifact + cap-and-kill + stats)
 * is identical to shellExec.
 */
export async function spawnArgv(args: SpawnArgvArgs): Promise<ToolResult> {
  if (args.signal?.aborted) {
    return { ok: false, output: "Command aborted.", exitCode: 130 };
  }

  const maxModelBytes = args.maxModelBytes ?? DEFAULT_MAX_MODEL_BYTES;
  const maxCaptureBytes = args.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES;
  const onLimit = args.onLimit ?? "continue";
  const halfModel = Math.max(512, Math.floor(maxModelBytes / 2));

  const display = `${args.command} ${args.argv.join(" ")}`.trim();
  const start = Date.now();
  const artifact = args.noArtifact
    ? undefined
    : await openArtifact(args.command, args.artifactPath);

  let head = "";
  const tail = new RingBuffer(halfModel);
  let bytesRead = 0;
  const decoder = new OutputDecoder();
  let bytesDropped = 0;
  let linesRead = 0;
  let captureLimitHit = false;

  return new Promise((resolve) => {
    const detached = process.platform !== "win32";
    // For spawnArgv we know the exact program; build an `argv0`-style
    // command preview that {@link looksInteractiveStdin} can inspect so
    // `pkg.install` (which invokes `sudo apt …` on Linux) lights up the
    // password-prompt path.
    const previewCommand = `${args.command} ${args.argv.join(" ")}`;
    const stdio = args.stdinText !== undefined
      ? (["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"])
      : chooseStdio(previewCommand, args.interactiveStdin);
    const usingInteractiveStdin = stdio[0] === "inherit";
    const restoreStdin = usingInteractiveStdin
      ? takeOverCookedStdin()
      : () => {};
    const child = spawn(args.command, args.argv, {
      cwd: args.cwd ?? safeCwd(),
      detached: detached && !usingInteractiveStdin,
      shell: false,
      stdio,
      env: { ...process.env, PATH: augmentedPathEnv() },
    });
    if (args.stdinText !== undefined) child.stdin?.end(args.stdinText);
    let aborted = false;
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      args.signal?.removeEventListener("abort", abort);
      restoreStdin();
      if (artifact) artifact.stream.end();
    };

    const append = (chunk: Buffer, stream: "stdout" | "stderr"): void => {
      const decoded = decoder.decode(chunk);
      const text = decoded.text;
      bytesRead += decoded.bytes;
      linesRead += text.split("\n").length - 1;
      if (artifact && !captureLimitHit) {
        if (bytesRead <= maxCaptureBytes) {
          artifact.stream.write(text);
        } else {
          const overflow = bytesRead - maxCaptureBytes;
          const allowed = text.length - overflow;
          if (allowed > 0) artifact.stream.write(text.slice(0, allowed));
          captureLimitHit = true;
          artifact.stream.end();
        }
      }
      if (head.length < halfModel) {
        const room = halfModel - head.length;
        head += text.slice(0, room);
        if (text.length > room) tail.push(text.slice(room));
      } else {
        tail.push(text);
      }
      const inMemory = head.length + tail.size();
      bytesDropped = Math.max(0, bytesRead - inMemory);
      args.onOutput?.(text, stream);
      if (captureLimitHit && onLimit === "terminate") terminate("cap");
    };

    const killChild = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      const useGroup = detached && !usingInteractiveStdin;
      if (!useGroup && process.platform !== "win32") {
        try {
          child.kill(signal);
        } catch {
          // already exited
        }
        return;
      }
      terminateProcessTree(child.pid, {
        signal,
        ...(useGroup ? { processGroupId: child.pid } : {}),
      });
    };

    const terminate = (reason: "abort" | "timeout" | "cap"): void => {
      if (reason === "abort") {
        if (aborted) {
          killChild("SIGKILL");
          return;
        }
        aborted = true;
      }
      if (reason === "timeout") timedOut = true;
      killChild("SIGTERM");
      forceKill = setTimeout(() => killChild("SIGKILL"), 500);
    };

    const abort = (): void => terminate("abort");

    child.stdout?.on("data", (chunk: Buffer) => append(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => append(chunk, "stderr"));
    child.on("error", (error) => {
      cleanup();
      if (aborted || args.signal?.aborted) {
        resolve({ ok: false, output: "Command aborted.", exitCode: 130 });
      } else {
        // Resolve a structured result instead of rejecting: every caller
        // (pkg.install, pentest.recon, pdf/image OCR) should see an actionable
        // "binary not found" ToolResult rather than a raw spawn ENOENT throw.
        const err = error as NodeJS.ErrnoException;
        const notFound = err.code === "ENOENT";
        resolve({
          ok: false,
          exitCode: 127,
          output: notFound
            ? `${args.command} was not found on PATH. Install it (pkg.install ${args.command}) or use a built-in tool instead.`
            : `Failed to launch ${args.command}: ${err.code ?? err.message}`,
        });
      }
    });
    child.on("close", (code) => {
      cleanup();
      const stats: ToolStats = {
        bytesRead,
        bytesDropped,
        linesRead,
        elapsedMs: Date.now() - start,
        captureLimitHit,
      };
      const trimmedTail = tail.toString().trim();
      const trimmedHead = head.trim();
      const inMemory = head.length + tail.size();
      let combined: string;
      if (bytesRead === 0) {
        combined = "";
      } else if (inMemory >= bytesRead) {
        combined = (head + tail.toString()).trimEnd();
      } else {
        const omittedBytes = bytesRead - inMemory;
        combined =
          `${trimmedHead}\n... (${omittedBytes.toLocaleString()} bytes / ~${linesRead.toLocaleString()} lines truncated — full output in artifact) ...\n${trimmedTail}`.trim();
      }
      const output = redactSecrets(`$ ${display}\n${combined}`.trimEnd());
      const finalize = (result: ToolResult): void => {
        if (artifact) {
          const onFlushed = (): void => {
            void redactArtifactInPlace(artifact.path).then(() =>
              resolve(result),
            );
          };
          if ((artifact.stream as WriteStream).writableFinished) {
            onFlushed();
          } else {
            artifact.stream.once("finish", onFlushed);
            artifact.stream.once("error", onFlushed);
          }
        } else {
          resolve(result);
        }
      };
      if (aborted || args.signal?.aborted) {
        finalize({
          ok: false,
          output: output ? `${output}\nCommand aborted.` : "Command aborted.",
          exitCode: 130,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (timedOut) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand timed out.`
            : "Command timed out.",
          exitCode: 124,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: bytesRead > inMemory,
          stats,
        });
        return;
      }
      if (captureLimitHit) {
        finalize({
          ok: false,
          output: output
            ? `${output}\nCommand killed after exceeding capture cap of ${maxCaptureBytes.toLocaleString()} bytes.`
            : "Command exceeded capture cap.",
          exitCode: 137,
          ...(artifact ? { outputPath: artifact.path } : {}),
          truncated: true,
          stats,
        });
        return;
      }
      const noMatchTool = benignNoMatchTool(args.command, code);
      const benignNote2 = (() => {
        if (!noMatchTool) return undefined;
        if (["diff", "diff3", "cmp", "comm"].includes(noMatchTool)) return `files differ`;
        if (["test", "["].includes(noMatchTool)) return `condition false`;
        return `no matching lines`;
      })();
      finalize({
        ok: code === 0 || noMatchTool !== undefined,
        output: noMatchTool
          ? `${output ? `${output}\n` : ""}[note: exit=1 from ${noMatchTool} (${benignNote2}) — not an error]`
          : output,
        exitCode: code ?? undefined,
        ...(artifact ? { outputPath: artifact.path } : {}),
        truncated: bytesRead > inMemory,
        stats,
      });
    });

    args.signal?.addEventListener("abort", abort, { once: true });
    timeout = setTimeout(
      () => terminate("timeout"),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  });
}
