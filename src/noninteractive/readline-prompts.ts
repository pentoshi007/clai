
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

export function restoreInteractiveStdin(io?: PromptIO): void {
  const input = resolveInput(io);
  if (!input.isTTY || typeof input.setRawMode !== "function") return;
  try {
    if (!input.isRaw) input.setRawMode(true);
    input.resume();
  } catch {
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

type Ask = (text: string) => Promise<string | undefined>;

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
    }
  }
  const rl = createInterface({
    input,
    output,
    terminal: Boolean(input.isTTY),
  });
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
