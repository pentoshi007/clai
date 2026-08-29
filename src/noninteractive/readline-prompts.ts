/**
 * Terminal prompts on `node:readline/promises` — the replacement for
 * `@inquirer/prompts` (06-ONESHOT.md §4). Streams are injectable so every
 * prompt is testable without a real TTY, and EOF resolves instead of hanging.
 */

import { createInterface } from "node:readline/promises";

export interface PromptStream extends NodeJS.ReadableStream {
  isTTY?: boolean | undefined;
  isRaw?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
}

export interface PromptIO {
  readonly input?: PromptStream | undefined;
  readonly output?: NodeJS.WritableStream | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** Message used when a confirmation is impossible on a non-TTY stdin. */
export const CONFIRMATION_REQUIRED_MESSAGE =
  "confirmation required; re-run with -y or --permissions allow-all";

const ECHO_OFF = "\u001b[8m";
const ECHO_ON = "\u001b[28m";

function resolveInput(io?: PromptIO): PromptStream {
  return io?.input ?? (process.stdin as PromptStream);
}

function resolveOutput(io?: PromptIO): NodeJS.WritableStream {
  return io?.output ?? process.stdout;
}

export function isInteractiveStdin(io?: PromptIO): boolean {
  return Boolean(resolveInput(io).isTTY);
}

/**
 * Re-assert raw mode AND resume stdin after a readline prompt. readline pauses
 * stdin and switches it to cooked mode when it closes; leaving it paused means
 * no `keypress`/`data` events reach the REPL's ESC/Ctrl+C abort handler, so a
 * tool launched right after a confirmation could no longer be aborted.
 */
export function restoreInteractiveStdin(io?: PromptIO): void {
  const input = resolveInput(io);
  if (!input.isTTY || typeof input.setRawMode !== "function") return;
  try {
    if (!input.isRaw) input.setRawMode(true);
    input.resume();
  } catch {
    /* ignore */
  }
}

export function releaseInteractiveStdin(io?: PromptIO): void {
  const input = resolveInput(io);
  if (!input.isTTY) return;
  try {
    if (input.isRaw && typeof input.setRawMode === "function") {
      input.setRawMode(false);
    }
    input.pause();
  } catch {}
}

/** Reads one line, or `undefined` once the stream ends (EOF / closed pipe). */
type Ask = (text: string) => Promise<string | undefined>;

/**
 * Run `body` against a single readline interface. One interface per prompt
 * session matters: a fresh interface would drop input already buffered by the
 * previous one, so retries must reuse this `ask`.
 */
async function session<T>(
  io: PromptIO | undefined,
  echo: boolean,
  body: (ask: Ask) => Promise<T>,
): Promise<T> {
  const input = resolveInput(io);
  const output = resolveOutput(io);
  const wasRaw = Boolean(input.isRaw);
  const suppressEcho = !echo && Boolean(input.isTTY);
  if (wasRaw && typeof input.setRawMode === "function") {
    try {
      input.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
  const rl = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY),
  });
  // Queue the lines ourselves: lines that arrive between two questions (a
  // retry, or a fast pipe) would otherwise be emitted with no listener
  // attached and silently lost, leaving the next question waiting forever.
  const pending: string[] = [];
  let deliver: ((line: string | undefined) => void) | undefined;
  rl.on("line", (line) => {
    if (deliver) {
      const resolve = deliver;
      deliver = undefined;
      resolve(line);
      return;
    }
    pending.push(line);
  });
  let ended = false;
  rl.once("close", () => {
    ended = true;
    if (deliver) {
      const resolve = deliver;
      deliver = undefined;
      resolve(undefined);
    }
  });
  const signal = io?.signal;
  const onAbort = (): void => {
    ended = true;
    if (deliver) {
      const resolve = deliver;
      deliver = undefined;
      resolve(undefined);
    }
    rl.close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const ask: Ask = async (text) => {
    const buffered = pending.shift();
    if (buffered !== undefined) return buffered;
    if (ended) return undefined;
    if (suppressEcho) output.write(ECHO_OFF);
    try {
      if (input.isTTY) {
        rl.setPrompt(text);
        rl.prompt();
      } else {
        output.write(text);
      }
      return await new Promise<string | undefined>((resolve) => {
        deliver = resolve;
      });
    } finally {
      if (suppressEcho) output.write(`${ECHO_ON}\n`);
    }
  };
  try {
    return await body(ask);
  } finally {
    signal?.removeEventListener("abort", onAbort);
    rl.close();
    if (wasRaw) restoreInteractiveStdin(io);
  }
}

export async function askLine(
  prompt: string,
  io?: PromptIO,
): Promise<string | undefined> {
  const answer = await session(io, true, (ask) => ask(`${prompt} `));
  return answer?.trim();
}

/** Read a value without displaying it; echo is suppressed only on a TTY. */
export async function askSecret(
  prompt: string,
  io?: PromptIO,
): Promise<string | undefined> {
  const answer = await session(io, false, (ask) => ask(`${prompt} `));
  return answer?.trim();
}

export function parseYesNo(answer: string): boolean | undefined {
  const value = answer.trim().toLowerCase();
  if (value === "y" || value === "yes") return true;
  if (value === "n" || value === "no") return false;
  return undefined;
}

/**
 * y/n question. Empty input takes `defaultValue`; unparseable input re-asks.
 * EOF answers "no" rather than hanging.
 */
export async function askYesNo(
  prompt: string,
  options?: PromptIO & { readonly defaultValue?: boolean },
): Promise<boolean> {
  const defaultValue = options?.defaultValue ?? true;
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  const output = resolveOutput(options);
  return session(options, true, async (ask) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await ask(`${prompt} ${suffix} `);
      if (answer === undefined) return false;
      if (answer.trim() === "") return defaultValue;
      const parsed = parseYesNo(answer);
      if (parsed !== undefined) return parsed;
      output.write("please answer y or n\n");
    }
    return false;
  });
}

export interface PromptChoice<T> {
  readonly name: string;
  readonly value: T;
}

/**
 * Numbered picker. Empty input takes the default choice; EOF or an invalid
 * selection after three tries resolves `undefined` so callers can cancel.
 */
export async function askChoice<T>(
  prompt: string,
  choices: readonly PromptChoice<T>[],
  options?: PromptIO & { readonly defaultIndex?: number },
): Promise<T | undefined> {
  if (choices.length === 0) return undefined;
  const output = resolveOutput(options);
  const defaultIndex = options?.defaultIndex ?? 0;
  const fallback = choices[defaultIndex] ?? choices[0]!;
  output.write(`${prompt}\n`);
  choices.forEach((choice, index) => {
    output.write(`  ${String(index + 1).padStart(2)}) ${choice.name}\n`);
  });
  return session(options, true, async (ask) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const answer = await ask(`select 1-${choices.length} [${defaultIndex + 1}] `);
      if (answer === undefined) return undefined;
      if (answer.trim() === "") return fallback.value;
      const index = Number.parseInt(answer.trim(), 10);
      if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
        return choices[index - 1]!.value;
      }
      output.write(`enter a number between 1 and ${choices.length}\n`);
    }
    return undefined;
  });
}
