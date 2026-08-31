import { ProviderError } from "../http.js";
import { readWithAbort } from "./abort-race.js";

const USAGE_INPUT_KEYS = [
  "prompt_tokens",
  "promptTokens",
  "input_tokens",
  "inputTokens",
] as const;

const USAGE_OUTPUT_KEYS = [
  "completion_tokens",
  "completionTokens",
  "output_tokens",
  "outputTokens",
] as const;

export function isFinalUsageFrame(parsed: {
  usage?: unknown;
  choices?: unknown[] | undefined;
}): boolean {
  if (Array.isArray(parsed.choices) && parsed.choices.length > 0) return false;
  const usage = parsed.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return false;
  const raw = usage as Record<string, unknown>;
  const reported = (keys: readonly string[]): boolean =>
    keys.some((key) => {
      const value = raw[key];
      return typeof value === "number" && Number.isFinite(value);
    });
  return reported(USAGE_INPUT_KEYS) && reported(USAGE_OUTPUT_KEYS);
}

/**
 * Mid-stream silence budget.
 *
 * This is deliberately generous because "no bytes" does **not** mean "dead
 * socket" on an OpenAI-compatible endpoint. Most self-hosted runtimes (vLLM /
 * SGLang and the tool-call parsers layered on top of them) buffer an entire
 * `tool_calls` delta before emitting it, so a model writing a large file goes
 * completely silent on the wire for as long as the generation takes. A 90s
 * budget aborted those healthy streams at `firstToken + 90s`, reported the
 * abort as a network failure, and burned three identical retries that each
 * re-generated the same prefix before one happened to finish inside the window.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 240_000;

export const THINKING_STREAM_IDLE_TIMEOUT_MS = 900_000;

export const THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS = 900_000;

export function streamIdleBudgets(reasoningEnabled: boolean): {
  idleTimeoutMs: number;
  outputIdleTimeoutMs: number;
} {
  const idleTimeoutMs = reasoningEnabled
    ? THINKING_STREAM_IDLE_TIMEOUT_MS
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  return {
    idleTimeoutMs,
    outputIdleTimeoutMs: Math.round(idleTimeoutMs * 1.5),
  };
}

/**
 * Marker appended to the message of a stall that happened on a **live**
 * connection (bytes/keepalives were still arriving, or output had already
 * started and simply stopped). Such a stall is not a transport failure, so the
 * recovery layer must not classify it as `network` and retry the identical
 * request against the identical route.
 */
export const STREAM_STALL_MARKER = "no model output";

export interface StreamLineReaderOptions {
  signal?: AbortSignal | undefined;
  idleTimeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  /** If provided, called after every read so callers can reset their own
   *  watchdogs (eg the OpenAI-compatible streamer's existing one). */
  onActivity?: (() => void) | undefined;
  outputIdleTimeoutMs?: number | undefined;
  outputProgress?: (() => number) | undefined;
}

export async function* readStreamLines(
  response: Response,
  options: StreamLineReaderOptions = {},
): AsyncGenerator<string, void, void> {
  if (!response.body) return;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const outputIdleTimeoutMs =
    options.outputIdleTimeoutMs ?? Math.round(idleTimeoutMs * 1.5);
  const trackOutput = typeof options.outputProgress === "function";
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const idleController = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  let outputTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  let firedWatchdog: "transport" | "output" = "transport";
  let lastOutputProgress = trackOutput ? options.outputProgress!() : 0;
  const fireStall = (watchdog: "transport" | "output"): void => {
    if (idleFired) return;
    idleFired = true;
    firedWatchdog = watchdog;
    idleController.abort();
  };
  const clearIdleTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (outputTimer) clearTimeout(outputTimer);
    idleTimer = undefined;
    outputTimer = undefined;
  };
  const armOutputTimer = (): void => {
    if (!trackOutput) return;
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = setTimeout(() => fireStall("output"), outputIdleTimeoutMs);
  };
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fireStall("transport"), idleTimeoutMs);
  };
  const noteOutputProgress = (): void => {
    if (!trackOutput) return;
    const current = options.outputProgress!();
    if (current <= lastOutputProgress) return;
    lastOutputProgress = current;
    armOutputTimer();
  };
  const stallError = (): ProviderError =>
    firedWatchdog === "output"
      ? new ProviderError(
          `Provider stream stalled — ${STREAM_STALL_MARKER} for ${Math.round(outputIdleTimeoutMs / 1000)}s.`,
        )
      : new ProviderError(
          `Provider stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s.`,
        );
  resetIdleTimer();
  armOutputTimer();
  const onCallerAbort = (): void =>
    idleController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  // A caller abort must surface as an abort error, not as a clean
  // end-of-stream — otherwise the partial text is returned as a successful
  // completion and enters history as the model's final answer.
  const callerAbortError = (): Error =>
    (options.signal?.reason as Error | undefined) ??
    new DOMException("The operation was aborted.", "AbortError");
  if (options.signal?.aborted) {
    clearIdleTimers();
    throw callerAbortError();
  }
  // If the idle watchdog already fired, bail before starting the loop.
  if (idleController.signal.aborted) {
    clearIdleTimers();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;

  const cancelReaderOnAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  idleController.signal.addEventListener("abort", cancelReaderOnAbort, {
    once: true,
  });

  try {
    while (true) {
      noteOutputProgress();
      if (idleController.signal.aborted) {
        if (idleFired) throw stallError();
        throw callerAbortError();
      }
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await readWithAbort(reader, idleController.signal);
      } catch (error) {
        if (idleFired) throw stallError();
        throw error;
      }
      const { done, value } = readResult;
      if (done) {
        if (idleFired) throw stallError();
        break;
      }
      if (value) {
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          throw new ProviderError(
            `Provider stream exceeded ${maxBytes.toLocaleString()} bytes — aborting.`,
          );
        }
      }
      resetIdleTimer();
      options.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) yield line;
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    idleController.signal.removeEventListener("abort", cancelReaderOnAbort);

    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

/**
 * Reassembles SSE `data:` frames.
 *
 * Per the SSE spec a single event's payload may be split across several `data:`
 * lines that the client must concatenate before parsing; each fragment was
 * previously parsed on its own, failed `JSON.parse`, and was dropped as a
 * malformed keepalive — losing content without a trace.
 *
 * A payload is released as soon as it is syntactically complete, so
 * single-line frames behave exactly as before. A blank line (frame terminator)
 * discards an incomplete remainder, and a runaway fragment is dropped rather
 * than corrupting later frames.
 */
export function createSseFrameAssembler(options?: {
  maxBufferedBytes?: number;
}): {
  /** Returns a complete payload, or undefined while still buffering. */
  pushLine: (line: string) => string | undefined;
} {
  const maxBufferedBytes = options?.maxBufferedBytes ?? 1_000_000;
  let buffered = "";
  const complete = (payload: string): boolean => {
    if (payload === "[DONE]") return true;
    try {
      JSON.parse(payload);
      return true;
    } catch {
      return false;
    }
  };
  return {
    pushLine(line: string): string | undefined {
      const trimmed = line.trim();
      if (trimmed === "") {
        // End of event: an incomplete remainder was malformed.
        buffered = "";
        return undefined;
      }
      if (!trimmed.startsWith("data:")) return undefined;
      const chunk = trimmed.slice(5).trim();
      buffered = buffered ? `${buffered}\n${chunk}` : chunk;
      if (complete(buffered)) {
        const payload = buffered;
        buffered = "";
        return payload;
      }
      if (buffered.length > maxBufferedBytes) buffered = "";
      return undefined;
    },
  };
}
