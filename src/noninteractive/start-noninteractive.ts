import type { ChatImage, Mode, ProviderId } from "../types.js";
import type { TurnOutcome } from "../agent/turn-outcome.js";
import { runAgent } from "../modes/agent.js";
import { interactiveSessionManager } from "../interactive-session/manager.js";
import { saveSession } from "../store/history.js";
import {
  createStdioConfirmPort,
  createStdioSecretPort,
} from "./stdio-confirm-port.js";
import { StreamRenderer } from "./stream-renderer.js";
import {
  releaseInteractiveStdin,
  type PromptStream,
} from "./readline-prompts.js";

export interface NoninteractiveOptions {
  readonly prompt: string;
  readonly historyPrompt?: string | undefined;
  readonly mode: Mode;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly noHistory?: boolean | undefined;
  readonly showThinking?: boolean | undefined;
  readonly verbose?: boolean | undefined;
  readonly quiet?: boolean | undefined;
  readonly images?: ChatImage[] | undefined;
  readonly visionProven?: boolean | undefined;
  readonly out?: NodeJS.WritableStream | undefined;
  readonly err?: NodeJS.WritableStream | undefined;
  readonly input?: PromptStream | undefined;
  readonly columns?: number | undefined;
  readonly color?: boolean | undefined;
  readonly unicode?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface NoninteractiveResult {
  readonly answer: string;
  readonly outcome: TurnOutcome;
  readonly exitCode: number;
}

function isTTY(stream: NodeJS.WritableStream): boolean {
  return (stream as NodeJS.WritableStream & { isTTY?: boolean }).isTTY === true;
}

function columnsFor(stream: NodeJS.WritableStream, columns?: number): number {
  if (columns !== undefined) return Math.max(1, Math.floor(columns));
  const value = (stream as NodeJS.WritableStream & { columns?: number }).columns;
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 80;
}

export function exitCodeForOutcome(outcome: Pick<TurnOutcome, "status">): number {
  return outcome.status === "aborted" ? 130 : 0;
}

export function exitCodeForError(_error: unknown): number {
  return 1;
}

export async function startNoninteractive(
  options: NoninteractiveOptions,
): Promise<NoninteractiveResult> {
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const input = options.input ?? (process.stdin as PromptStream);
  const tty = isTTY(out);
  const plain = process.env.CLAI_CLASSIC_UI?.trim().toLowerCase() === "plain";
  const renderer = new StreamRenderer({
    out,
    err,
    columns: columnsFor(out, options.columns),
    color: options.color ?? (tty && process.env.NO_COLOR === undefined && !plain),
    unicode: options.unicode ?? (tty && !plain),
    verbosity: options.quiet ? "quiet" : options.verbose ? "verbose" : "normal",
    showThinking: options.showThinking ?? process.env.CLAI_SHOW_THINKING === "1",
  });
  const confirm = createStdioConfirmPort({ input, output: err });
  const requestSecret = createStdioSecretPort({ input, output: err });
  const controller = new AbortController();
  const forwardAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const abortFromProcess = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error("Aborted."));
  };
  process.once("SIGINT", abortFromProcess);
  process.once("SIGTERM", abortFromProcess);
  let outcome: TurnOutcome | undefined;
  let answer = "";

  try {
    answer = await runAgent(options.prompt, {
      provider: options.provider,
      model: options.model,
      autoConfirm: options.yes,
      mode: options.mode,
      images: options.images,
      visionProven: options.visionProven,
      signal: controller.signal,
      displayPrompt: options.historyPrompt ?? options.prompt,
      confirm,
      requestSecret,
      onEvent: (event) => renderer.handle(event),
      onOutcome: (value) => {
        outcome = value;
      },
    });
    if (!outcome) throw new Error("Agent completed without a turn outcome");
    renderer.finish(outcome);
    if (!options.noHistory) {
      await saveSession([
        { role: "user", content: options.historyPrompt ?? options.prompt },
        { role: "assistant", content: answer },
      ]);
    }
    return {
      answer,
      outcome,
      exitCode: exitCodeForOutcome(outcome),
    };
  } finally {
    options.signal?.removeEventListener("abort", forwardAbort);
    releaseInteractiveStdin({ input });
    process.off("SIGINT", abortFromProcess);
    process.off("SIGTERM", abortFromProcess);
    const cleanup = await interactiveSessionManager
      .closeAll("app-shutdown")
      .catch(() => undefined);
    for (const failure of cleanup?.failures ?? []) {
      err.write(
        `interactive-session cleanup: [${failure.code}] ${failure.message}\n`,
      );
    }
  }
}
