import type { CompletionRequest, CompletionResult } from "../types.js";
import type { ProviderAuth } from "./provider.js";
import {
  ProviderError,
  createSseFrameAssembler,
  readJson,
  STREAM_STALL_MARKER,
} from "./http.js";
import { generationFetch } from "./operation-usage.js";
import { withReasoningObservation } from "./token-usage.js";
import {
  emitStreamReasoningArtifacts,
  emitStreamReasoningDelta,
} from "./stream-events.js";
import { requireTerminalProof } from "./stream-terminal.js";
import type { ResponsesDialectConfig } from "./responses-config.js";
import {
  assembleCompletionResult,
  collectEofToolCalls,
  isOutputBudgetIncomplete,
  parseResponsesOutput,
  parseResponsesUsage,
  responsesReasoningArtifacts,
} from "./responses-parse.js";
import {
  buildResponsesRequestBody,
  readResponsesJson,
  readWithAbort,
} from "./responses-http.js";
import { createStreamIdleWatchdog } from "./responses-stream-watchdog.js";
import type { StreamIdleWatchdog } from "./responses-stream-watchdog.js";
import { newStreamAccumulator } from "./responses-stream-accumulator.js";
import type {
  StreamAccumulator,
  StreamEventContext,
} from "./responses-stream-accumulator.js";
import {
  finalizeStreamResult,
  maybeAppendPrivateReasoning,
  processStreamPayload,
} from "./responses-stream-events.js";

async function openResponsesStream(
  config: ResponsesDialectConfig,
  auth: ProviderAuth,
  body: string,
  request: CompletionRequest,
  watchdog: StreamIdleWatchdog,
): Promise<Response> {
  let response: Response | undefined;
  let lastFetchError: unknown;
  for (let fetchAttempt = 0; fetchAttempt < 2; fetchAttempt++) {
    if (fetchAttempt > 0) {
      await new Promise((r) => setTimeout(r, 1000));
      if (request.signal?.aborted) throw request.signal.reason;
      if (watchdog.fired()) break;
      watchdog.armInitialTransport();
      watchdog.armOutputTimer();
    }
    try {
      response = await generationFetch(`${config.baseUrl}/responses`, {
        method: "POST",
        signal: watchdog.controller.signal,
        headers: config.buildHeaders(auth, "text/event-stream"),
        body,
        verbose: process.env.CLAI_VERBOSE === "true",
      } as unknown as RequestInit);
      lastFetchError = undefined;
      break;
    } catch (error) {
      lastFetchError = error;
      if (watchdog.fired()) {
        throw new ProviderError(
          `${config.displayName} request timed out before any response (${Math.round(watchdog.firedBudgetMs() / 1000)}s) — no data arrived on the connection.`,
        );
      }
      const msg = error instanceof Error ? error.message : String(error);
      const transient =
        /fetch failed|network error|etimedout|enotfound|econnreset|premature close|socket.*closed|aborted without reason/i.test(
          msg,
        );
      if (!transient || watchdog.sawStreamProgress()) throw error;
      continue;
    }
  }
  if (!response) {
    if (lastFetchError) throw lastFetchError;
    throw new ProviderError(
      `${config.displayName} request failed before a response was received.`,
    );
  }
  return response;
}

function streamStallError(
  config: ResponsesDialectConfig,
  watchdog: StreamIdleWatchdog,
): ProviderError {
  const seconds = Math.round(watchdog.firedBudgetMs() / 1000);
  if (watchdog.firedWatchdog() === "transport" || !watchdog.sawTransportActivity()) {
    if (!watchdog.sawTransportActivity()) {
      return new ProviderError(
        `${config.displayName} request timed out before any response (${seconds}s) — no data arrived on the connection.`,
      );
    }
    return new ProviderError(
      `${config.displayName} stream transport timeout (${seconds}s) — no data arrived on the connection after it had started.`,
    );
  }
  return new ProviderError(
    `${config.displayName} stream stalled — ${STREAM_STALL_MARKER} for ${seconds}s`,
  );
}

function streamLoopStallError(
  config: ResponsesDialectConfig,
  watchdog: StreamIdleWatchdog,
): ProviderError {
  const seconds = Math.round(watchdog.firedBudgetMs() / 1000);
  if (watchdog.firedWatchdog() === "transport" || !watchdog.sawTransportActivity()) {
    if (!watchdog.sawTransportActivity()) {
      return new ProviderError(
        `${config.displayName} request timed out before any response (${seconds}s) — no data arrived on the connection.`,
      );
    }
    return new ProviderError(
      `${config.displayName} stream transport timeout (${seconds}s) — no data arrived on the connection after it had started.`,
    );
  }
  return new ProviderError(
    `${config.displayName} stream stalled — ${STREAM_STALL_MARKER} for ${seconds}s` +
      (watchdog.sawStreamProgress()
        ? " after it had already started producing output. The connection stayed open, so the model was most likely buffering one very large tool call. Split large writes into smaller sequential calls, or try a smaller model / disable thinking with /effort off."
        : " — the connection stayed open but the model never produced anything. Try another model, or disable thinking with /effort off."),
  );
}

interface JsonFallbackContext {
  config: ResponsesDialectConfig;
  model: string;
  request: CompletionRequest;
  onToken: (token: string) => void;
}

function jsonFallbackResult(
  ctx: JsonFallbackContext,
  data: { output?: unknown; usage?: unknown; id?: string; requestId?: string },
): CompletionResult | undefined {
  const parsed = parseResponsesOutput(data);
  const reasoningArtifacts = responsesReasoningArtifacts(
    ctx.config,
    ctx.model,
    parsed.reasoningItems,
    parsed.reasoningItemPositions,
  );
  const usage = withReasoningObservation(
    parsed.usage ?? parseResponsesUsage((data as Record<string, unknown>).usage),
    Boolean(parsed.reasoningSummary.trim()),
  );
  const outputBudgetIncomplete = isOutputBudgetIncomplete(
    data as Record<string, unknown>,
  );
  if (
    !outputBudgetIncomplete &&
    !parsed.text.trim() &&
    parsed.toolCalls.length === 0 &&
    !parsed.reasoningSummary.trim()
  ) {
    return undefined;
  }
  emitStreamReasoningArtifacts(ctx.request.onStreamEvent, reasoningArtifacts);
  if (parsed.reasoningSummary) {
    emitStreamReasoningDelta(ctx.request.onStreamEvent, parsed.reasoningSummary);
  }
  if (parsed.text) ctx.onToken(parsed.text);
  return assembleCompletionResult({
    config: ctx.config,
    model: ctx.model,
    parsed,
    usage,
    reasoningArtifacts,
    outputBudgetIncomplete,
  });
}

async function handleJsonStreamResponse(
  ctx: JsonFallbackContext,
  response: Response,
  watchdog: StreamIdleWatchdog,
): Promise<CompletionResult> {
  try {
    const data = await readJson<{
      output?: unknown;
      usage?: unknown;
      id?: string;
      requestId?: string;
    }>(response, watchdog.controller.signal);
    if (response.status === 202) {
      const requestId =
        (data as Record<string, unknown>).requestId ??
        (data as Record<string, unknown>).id;
      throw new ProviderError(
        `${ctx.config.displayName} returned a pending async response${requestId ? ` (${requestId})` : ""}; streaming did not start.`,
        response.status,
        JSON.stringify(data).slice(0, 1_000),
      );
    }
    const result = jsonFallbackResult(ctx, data);
    if (result) return result;
    throw new ProviderError(
      `${ctx.config.displayName} returned JSON instead of an SSE stream, but no completion text was present.`,
      response.status,
      JSON.stringify(data).slice(0, 1_000),
    );
  } catch (error) {
    if (watchdog.fired()) throw streamStallError(ctx.config, watchdog);
    throw error;
  }
}

function throwIfStreamAborted(
  request: CompletionRequest,
  controller: AbortController,
): void {
  request.signal?.throwIfAborted();
  if (controller.signal.aborted) throw new Error("Stream aborted");
}

async function runResponsesStreamLoop(
  ctx: StreamEventContext,
  response: Response,
): Promise<CompletionResult> {
  const { config, request, state, watchdog } = ctx;
  const decoder = new TextDecoder();
  const reader = response.body!.getReader();
  let buffer = "";
  const cancelReaderOnAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  watchdog.controller.signal.addEventListener("abort", cancelReaderOnAbort, {
    once: true,
  });
  const sseFrames = createSseFrameAssembler();
  try {
    while (true) {
      throwIfStreamAborted(request, watchdog.controller);
      const { done, value } = await readWithAbort(reader, watchdog.controller.signal);
      throwIfStreamAborted(request, watchdog.controller);
      if (done) break;
      if (value && value.byteLength > 0) watchdog.noteTransportActivity();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = sseFrames.pushLine(line);
        if (payload === undefined) continue;
        const finished = processStreamPayload(ctx, payload);
        if (finished) return finished;
      }
    }
    maybeAppendPrivateReasoning(ctx);
    requireStreamTerminalProof(config, state);
    return finalizeStreamResult(ctx, collectEofToolCalls(state.toolCallState));
  } catch (error) {
    if (watchdog.fired()) throw streamLoopStallError(config, watchdog);
    throw error;
  } finally {
    watchdog.controller.signal.removeEventListener("abort", cancelReaderOnAbort);
    void reader.cancel().catch(() => undefined);
    tryReleaseReader(reader);
  }
}

function requireStreamTerminalProof(
  config: ResponsesDialectConfig,
  state: StreamAccumulator,
): void {
  let toolArgumentBytes = 0;
  for (const s of state.toolCallState.values()) toolArgumentBytes += s.arguments.length;
  requireTerminalProof({
    provider: config.displayName,
    policy: config.terminalPolicy,
    signal: state.sawTerminalProof,
    answerBytes: state.full.length,
    reasoningBytes: state.reasoningSeen.length,
    toolArgumentBytes,
  });
}

function tryReleaseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    reader.releaseLock();
  } catch {
    return;
  }
}

export async function responsesStream(
  config: ResponsesDialectConfig,
  request: CompletionRequest,
  auth: ProviderAuth,
  onToken: (token: string) => void,
  model: string,
): Promise<CompletionResult> {
  const watchdog = createStreamIdleWatchdog();
  const onCallerAbort = (): void =>
    watchdog.controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });
  const body = buildResponsesRequestBody(config, request, model, true);
  const cleanup = (): void => {
    watchdog.clear();
    request.signal?.removeEventListener("abort", onCallerAbort);
  };
  let response: Response;
  try {
    response = await openResponsesStream(config, auth, body, request, watchdog);
  } catch (error) {
    cleanup();
    throw error;
  }
  try {
    await ensureStreamResponseOk(config, model, response, watchdog);
    if (isJsonStreamResponse(response)) {
      return await handleJsonStreamResponse(
        { config, model, request, onToken },
        response,
        watchdog,
      );
    }
    const ctx = buildStreamEventContext(config, model, request, watchdog, onToken);
    return await runResponsesStreamLoop(ctx, response);
  } finally {
    cleanup();
  }
}

function buildStreamEventContext(
  config: ResponsesDialectConfig,
  model: string,
  request: CompletionRequest,
  watchdog: StreamIdleWatchdog,
  onToken: (token: string) => void,
): StreamEventContext {
  const state = newStreamAccumulator();
  const emitVisible = (text: string): void => {
    if (!text) return;
    state.visible += text;
    state.full += text;
    onToken(text);
  };
  const emitReasoningDelta = (text: string): void => {
    if (!text) return;
    state.reasoningSeen += text;
    emitStreamReasoningDelta(request.onStreamEvent, text);
  };
  return {
    config,
    model,
    request,
    state,
    watchdog,
    emitVisible,
    emitReasoningDelta,
  };
}

function isJsonStreamResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  return response.status === 202 || /\bapplication\/json\b/i.test(contentType);
}

async function ensureStreamResponseOk(
  config: ResponsesDialectConfig,
  model: string,
  response: Response,
  watchdog: StreamIdleWatchdog,
): Promise<void> {
  if (!response.ok) {
    watchdog.clear();
    await readResponsesJson(config, model, response);
  }
  if (!response.body) {
    watchdog.clear();
    throw new ProviderError(`${config.displayName} returned no stream body`);
  }
}
