import type {
  ChatMessage,
  NativeToolCall,
  ProviderId,
  ReasoningArtifact,
  ReasoningArtifactReplayObserver,
  ReasoningPreference,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "../../types.js";
import { learnModelEmitsReasoning } from "../capabilities.js";
import { ProviderError } from "../http.js";
import { generationFetch } from "../operation-usage.js";
import type { StreamTerminalProof } from "../provider-profile.js";
import { visibleReasoningDetailText } from "../reasoning-artifacts.js";
import { inBandBadRequestStatus } from "../reasoning-errors.js";
import { compileRequestPlan } from "../request-plan.js";
import {
  emitStreamReasoningArtifacts,
  emitStreamReasoningDelta,
} from "../stream-events.js";
import type { ProviderStreamEventSink } from "../stream-events.js";
import {
  CHAT_COMPLETIONS_STREAM_TERMINAL,
  requireTerminalProof,
} from "../stream-terminal.js";
import type { StreamTerminalPolicy } from "../stream-terminal.js";
import { parseFireworksUsage, parseOpenAiUsage } from "../token-usage.js";
import type { CompatibleUsageAliases } from "../token-usage.js";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
  fromWireName,
  parseOpenAiMessageToolCalls,
} from "../tool-protocol.js";
import { readWithAbort } from "./abort-race.js";
import { chatCompletionsBodyFromPlan } from "./chat-body.js";
import {
  artifactRaw,
  compatibleArtifactPolicyFor,
  CompatibleReasoningArtifactPolicy,
  compatibleReasoningArtifacts,
  OpenAiCompatibleResult,
  openAiReasoningText,
  privateReasoningNote,
} from "./reasoning-artifacts.js";
import { ReasoningStyle } from "./reasoning-payload.js";
import { readJson } from "./response-errors.js";
import {
  createSseFrameAssembler,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  isFinalUsageFrame,
  STREAM_STALL_MARKER,
  THINKING_STREAM_IDLE_TIMEOUT_MS,
  THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS,
} from "./stream-framing.js";

export async function openAiCompatibleStream(options: {
  provider: string;
  /** Canonical provider id used for capability lookups. */
  providerId: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  onToken: (token: string) => void;
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  onStreamEvent?: ProviderStreamEventSink | undefined;
  streamTerminal?: StreamTerminalPolicy | undefined;
  /** Omit usage stream options for strict OpenAI-compatible gateways. */
  includeStreamUsage?: boolean | undefined;
  /** Optional response-usage aliases for one configured compatible route. */
  usageAliases?: CompatibleUsageAliases | undefined;
  /** Explicit route policy; without one, final-turn artifacts are not retained. */
  reasoningArtifactPolicy?: CompatibleReasoningArtifactPolicy | undefined;
  /** Metadata-only replay decisions; raw artifact payloads are never exposed. */
  reasoningArtifactReplayObserver?: ReasoningArtifactReplayObserver | undefined;
  forceReasoningReplay?: boolean | undefined;
  /** Early native tool-call name/args progress (P2-3). */
  onToolCallDelta?:
    | ((delta: {
        index: number;
        id?: string;
        name?: string;
        argumentsBytes?: number;
      }) => void)
    | undefined;
  /** Abort a stream that delivers no bytes for this long (mid-stream). */
  idleTimeoutMs?: number | undefined;

  initialIdleTimeoutMs?: number | undefined;
  /**
   * Abort a stream that delivers bytes but no model output for this long.
   * Bounds a keepalive-only stream. Defaults to 1.5x the largest byte budget so
   * it always outlasts the transport watchdog.
   */
  outputIdleTimeoutMs?: number | undefined;
}): Promise<OpenAiCompatibleResult> {
  // Combine the caller's abort signal with an idle watchdog so a stuck
  // connection can't wedge the REPL forever. Thinking models get a much
  // longer first-byte budget and a longer mid-stream silence budget —
  // the old 30s default aborted healthy Bynara/OpenRouter streams that
  // were still "thinking" without tokens.
  const reasoningOn = Boolean(options.reasoning?.enabled);
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    (reasoningOn
      ? THINKING_STREAM_IDLE_TIMEOUT_MS
      : DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  const initialIdleTimeoutMs =
    options.initialIdleTimeoutMs ??
    (reasoningOn ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS : idleTimeoutMs);
  // "No bytes" and "no output" are different failures and need separate
  // budgets. The transport watchdog is re-armed by every read, so an SSE
  // keepalive comment, a `delta:{}` heartbeat, a role-only opening delta, or a
  // multi-line frame still being assembled all count as proof that the
  // connection is healthy. The output watchdog is re-armed only by real model
  // progress, so a stream that keepalives forever without ever producing
  // anything still fails instead of hanging.
  const outputIdleTimeoutMs =
    options.outputIdleTimeoutMs ??
    Math.round(Math.max(idleTimeoutMs, initialIdleTimeoutMs) * 1.5);
  const idleController = new AbortController();
  let transportTimer: NodeJS.Timeout | undefined;
  let outputTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  let firedWatchdog: "transport" | "output" | undefined;
  /** Budget of whichever watchdog fired, for the error message. */
  let firedBudgetMs = initialIdleTimeoutMs;
  /**
   * Any bytes at all read off the socket, whether or not the frame carried
   * model output. Separates "the route never answered" (retry the request) from
   * "the model was working and went quiet" (a retry replays all of that work).
   */
  let sawTransportActivity = false;
  /** Model-visible progress: content, reasoning, tool-call delta, or usage. */
  let sawStreamProgress = false;
  const fireStall = (
    watchdog: "transport" | "output",
    budgetMs: number,
  ): void => {
    // The two timers can expire in the same event-loop turn. Preserve the first
    // cause so a transport outage is never relabeled by the output watchdog.
    if (idleFired) return;
    idleFired = true;
    firedWatchdog = watchdog;
    firedBudgetMs = budgetMs;
    idleController.abort();
  };
  const armTransportTimer = (budgetMs: number): void => {
    if (transportTimer) clearTimeout(transportTimer);
    transportTimer = setTimeout(
      () => fireStall("transport", budgetMs),
      budgetMs,
    );
  };
  /** Bytes arrived — the connection is alive; re-arm the mid-stream budget. */
  const noteTransportActivity = (): void => {
    sawTransportActivity = true;
    armTransportTimer(idleTimeoutMs);
  };
  const resetIdleTimer = (): void => {
    sawStreamProgress = true;
    noteTransportActivity();
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = setTimeout(
      () => fireStall("output", outputIdleTimeoutMs),
      outputIdleTimeoutMs,
    );
  };
  armTransportTimer(initialIdleTimeoutMs);
  outputTimer = setTimeout(
    () => fireStall("output", outputIdleTimeoutMs),
    outputIdleTimeoutMs,
  );
  const clearIdleTimers = (): void => {
    if (transportTimer) clearTimeout(transportTimer);
    if (outputTimer) clearTimeout(outputTimer);
    transportTimer = undefined;
    outputTimer = undefined;
  };
  const onCallerAbort = (): void =>
    idleController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const plan = compileRequestPlan({
    provider: options.providerId,
    model: options.model,
    messages: options.messages,
    stream: true,
    endpoint: options.baseUrl,
    reasoning: options.reasoning,
    tools: options.tools,
    toolChoice: options.toolChoice,
    parallelToolCalls: options.parallelToolCalls,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });
  const requestBody = chatCompletionsBodyFromPlan(plan, {
    reasoningStyle: options.reasoningStyle,
    includeStreamUsage: options.includeStreamUsage,
    reasoningArtifactReplayObserver: options.reasoningArtifactReplayObserver,
    ...(options.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
  });
  let response: Response;
  try {
    response = await generationFetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      signal: idleController.signal,
      headers: {
        "content-type": "application/json",

        accept: "text/event-stream",
        ...(options.apiKey
          ? { authorization: `Bearer ${options.apiKey}` }
          : {}),
        ...options.headers,
      },
      body: requestBody,
      verbose: process.env.CLAI_VERBOSE === "true",
    } as any);
  } catch (error) {
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    if (idleFired) {
      throw new ProviderError(
        `${options.provider} request timed out before any response (${Math.round(firedBudgetMs / 1000)}s)`,
      );
    }
    throw error;
  }
  if (!response.ok) {
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    try {
      await readJson<unknown>(response);
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new ProviderError(
          `${options.provider} (model=${options.model}): ${error.message}`,
          error.status,
          error.body,
          error.retryAfterSeconds,
        );
      }
      throw error;
    }
  }
  if (!response.body) {
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    throw new ProviderError(`${options.provider} returned no stream body`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 202 || /\bapplication\/json\b/i.test(contentType)) {
    try {
      const data = await readJson<{
        id?: string;
        requestId?: string;
        status?: string;
        usage?: unknown;
        choices?: Array<{
          finish_reason?: string;
          message?: {
            content?: string | null;
            reasoning_content?: string;
            reasoning?: string;
            reasoning_details?: unknown;
            thinking?: unknown;
            thinking_signature?: string | null;
            extra_content?: { google?: { thought_signature?: string } };
            tool_calls?: Array<{
              id?: string;
              type?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      }>(response, idleController.signal);
      if (response.status === 202) {
        const requestId = data.requestId ?? data.id;
        throw new ProviderError(
          `${options.provider} returned a pending async response${requestId ? ` (${requestId})` : ""}; streaming did not start.`,
          response.status,
          JSON.stringify(data).slice(0, 1_000),
        );
      }
      const choice = data.choices?.[0];
      const message = choice?.message;
      const toolCalls = parseOpenAiMessageToolCalls(message?.tool_calls);
      const text = message?.content ?? "";
      const jsonUsage =
        options.providerId === "fireworks"
          ? parseFireworksUsage(
              data.usage,
              (data as { perf_metrics?: unknown }).perf_metrics,
              response.headers,
            )
          : parseOpenAiUsage(data.usage, options.usageAliases);
      const reasoning = openAiReasoningText(message);
      const detailsRaw = artifactRaw(message?.reasoning_details);
      const thoughtSignature =
        message?.extra_content?.google?.thought_signature;
      const reasoningArtifacts = compatibleReasoningArtifacts({
        providerId: options.providerId,
        model: options.model,
        baseUrl: options.baseUrl,
        toolCalls,
        policy:
          options.reasoningArtifactPolicy ??
          compatibleArtifactPolicyFor(
            plan.policy.reasoning.finalTurnPreservation,
          ),
        ...(typeof reasoning === "string" && reasoning
          ? { reasoning: { text: reasoning, sequence: 0 } }
          : {}),
        ...(detailsRaw ? { details: [{ raw: detailsRaw, sequence: 1 }] } : {}),
        ...(thoughtSignature
          ? {
              thoughtSignatures: [
                {
                  raw: thoughtSignature,
                  sequence: 2,
                  ...(toolCalls.length ? { toolCallIndex: 0 } : {}),
                },
              ],
            }
          : {}),
      });
      if (
        text.trim() ||
        toolCalls.length > 0 ||
        (typeof reasoning === "string" && reasoning.trim())
      ) {
        emitStreamReasoningArtifacts(options.onStreamEvent, reasoningArtifacts);
        if (text) options.onToken(text);
        return {
          text,
          ...(toolCalls.length ? { toolCalls } : {}),
          ...(choice?.finish_reason
            ? { finishReason: choice.finish_reason }
            : toolCalls.length
              ? { finishReason: "tool_calls" }
              : {}),
          ...(jsonUsage ? { usage: jsonUsage } : {}),
          ...(typeof reasoning === "string" && reasoning
            ? { reasoningBlock: { text: reasoning } }
            : visibleReasoningDetailText(detailsRaw)
              ? {
                  reasoningBlock: {
                    text: visibleReasoningDetailText(detailsRaw)!,
                  },
                }
              : {}),
          ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
        };
      }
      throw new ProviderError(
        `${options.provider} returned JSON instead of an SSE stream, but no completion text was present.`,
        response.status,
        JSON.stringify(data).slice(0, 1_000),
      );
    } catch (error) {
      if (idleFired) {
        const seconds = Math.round(firedBudgetMs / 1000);
        if (firedWatchdog === "transport" || !sawTransportActivity) {
          if (!sawTransportActivity) {
            throw new ProviderError(
              `${options.provider} request timed out before any response (${seconds}s) — no data arrived on the connection.`,
            );
          }
          throw new ProviderError(
            `${options.provider} stream transport timeout (${seconds}s) — no data arrived on the connection after it had started.`,
          );
        }
        throw new ProviderError(
          `${options.provider} stream stalled — ${STREAM_STALL_MARKER} for ${seconds}s`,
        );
      }
      throw error;
    } finally {
      clearIdleTimers();
      options.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let full = "";
  let visible = "";
  let reasoningSeen = "";
  let contentWireSeen = "";
  let reasoningWireSeen = "";
  let finishReason: string | undefined;
  let terminalSignal: StreamTerminalProof | undefined;
  const terminalPolicy =
    options.streamTerminal ??
    (plan.policy.terminal.proofs.length > 0
      ? plan.policy.terminal
      : CHAT_COMPLETIONS_STREAM_TERMINAL);
  const emittedByteCounts = (): {
    answerBytes: number;
    reasoningBytes: number;
    toolArgumentBytes: number;
  } => {
    let toolArgumentBytes = 0;
    for (const state of toolCallState.values()) {
      toolArgumentBytes += state.arguments.length;
    }
    return {
      answerBytes: visible.length,
      reasoningBytes: reasoningSeen.length,
      toolArgumentBytes,
    };
  };
  let streamUsage: TokenUsage | undefined =
    options.providerId === "fireworks"
      ? parseFireworksUsage(undefined, undefined, response.headers)
      : undefined;
  const toolCallState = new Map<
    number,
    { id?: string; name?: string; arguments: string }
  >();
  let reasoningArtifactSequence: number | undefined;
  let nextArtifactSequence = 0;
  let lastToolCallIndex: number | undefined;
  const structuredDetails: Array<{
    raw: ReasoningArtifact["raw"];
    sequence: number;
  }> = [];
  const thoughtSignatures: Array<{
    raw: string;
    sequence: number;
    toolCallIndex?: number | undefined;
  }> = [];
  const pendingThoughtSignatures: Array<{
    raw: string;
    sequence: number;
    toolCallIndex?: number | undefined;
  }> = [];

  const finalReasoningArtifacts = (toolCalls: readonly NativeToolCall[]) => {
    if (pendingThoughtSignatures.length) {
      const toolCallIndex = toolCalls.length ? 0 : undefined;
      for (const capture of pendingThoughtSignatures.splice(0)) {
        thoughtSignatures.push(
          toolCallIndex === undefined ? capture : { ...capture, toolCallIndex },
        );
      }
    }
    return compatibleReasoningArtifacts({
      providerId: options.providerId,
      model: options.model,
      baseUrl: options.baseUrl,
      toolCalls,
      policy:
        options.reasoningArtifactPolicy ??
        compatibleArtifactPolicyFor(
          plan.policy.reasoning.finalTurnPreservation,
        ),
      ...(reasoningSeen
        ? {
            reasoning: {
              text: reasoningSeen,
              sequence: reasoningArtifactSequence ?? 0,
            },
          }
        : {}),
      ...(structuredDetails.length ? { details: structuredDetails } : {}),
      ...(thoughtSignatures.length ? { thoughtSignatures } : {}),
    });
  };

  const displayReasoningText = (): string => {
    if (reasoningSeen) return reasoningSeen;
    return structuredDetails
      .map((detail) => visibleReasoningDetailText(detail.raw) ?? "")
      .join("");
  };

  const normalizeChannelDelta = (
    token: string,
    seen: string,
    snapshotThreshold = 64,
  ): { delta: string; seen: string } => {
    const extendsSnapshot =
      token.length > seen.length && token.startsWith(seen);
    const repeatsEstablishedSnapshot =
      seen.length >= 64 && token.length === seen.length && token === seen;
    if (
      seen.length >= snapshotThreshold &&
      (extendsSnapshot || repeatsEstablishedSnapshot)
    ) {
      return { delta: token.slice(seen.length), seen: token };
    }
    return { delta: token, seen: seen + token };
  };

  const emitPrivateReasoningNote = (hasToolCalls: boolean): void => {
    if (reasoningSeen.trim()) return;
    if (!visible.trim() && !hasToolCalls) return;
    const tokens = streamUsage?.reasoningTokens ?? 0;
    if (tokens <= 0) return;
    const note = privateReasoningNote(options.provider, requestBody, tokens);
    emitStreamReasoningDelta(options.onStreamEvent, note);
  };

  /**
   * Reasoning-echo suppression.
   *
   * Some gateways/models stream the chain of thought on `reasoning_content` and
   * then replay it verbatim at the start of `content` before the real answer
   * (observed with MiniMax M3 and GLM). Untagged, that replay is
   * indistinguishable from an answer, so it was rendered as the response — the
   * user saw the model's reasoning as its reply even with thinking off.
   *
   * While the leading `content` still matches reasoning we already received, it
   * is kept inside the `<think>` region: never a visible answer, still visible
   * under Ctrl+T, and stripped from history. Only the first
   * ECHO_CONFIRM_CHARS are held back before deciding, so a normal answer is
   * emitted with no perceptible delay.
   */
  const ECHO_CONFIRM_CHARS = 64;
  let echoState: "idle" | "buffering" | "echoing" | "done" = "idle";
  let echoBuffer = "";
  let echoPos = 0;

  const emitVisible = (text: string): void => {
    if (!text) return;
    visible += text;
    full += text;
    options.onToken(text);
  };
  /**
   * Route replayed text back into the reasoning region. Deliberately does NOT
   * extend `reasoningSeen`: that string is the comparison baseline, and growing
   * it with the replay would let the echo match itself past the real reasoning.
   */
  const emitReasoningEcho = (text: string): void => {
    if (!text) return;
    emitStreamReasoningDelta(options.onStreamEvent, text);
  };
  /** Release a still-undecided hold-back as the answer (stream ended early). */
  const flushEchoBuffer = (): void => {
    if (!echoBuffer) return;
    const held = echoBuffer;
    echoBuffer = "";
    echoState = "done";
    emitVisible(held);
  };

  const handleContentToken = (token: string): void => {
    if (echoState === "done") {
      emitVisible(token);
      return;
    }
    if (echoState === "idle") {
      // A replay is only plausible once a meaningful amount of reasoning came
      // through the separate channel.
      if (reasoningSeen.length < ECHO_CONFIRM_CHARS) {
        echoState = "done";
        emitVisible(token);
        return;
      }
      echoState = "buffering";
    }
    if (echoState === "buffering") {
      echoBuffer += token;
      if (reasoningSeen.startsWith(echoBuffer)) {
        if (echoBuffer.length >= ECHO_CONFIRM_CHARS) {
          const confirmed = echoBuffer;
          echoBuffer = "";
          echoPos = confirmed.length;
          echoState = "echoing";
          emitReasoningEcho(confirmed);
        }
        return;
      }
      flushEchoBuffer();
      return;
    }
    // Confirmed replay: consume the matching run, then hand over the answer.
    let matched = 0;
    while (
      matched < token.length &&
      reasoningSeen[echoPos + matched] === token[matched]
    ) {
      matched += 1;
    }
    if (matched > 0) {
      emitReasoningEcho(token.slice(0, matched));
      echoPos += matched;
    }
    if (matched < token.length) {
      echoState = "done";
      emitVisible(token.slice(matched));
    }
  };

  const cleanup = (): void => {
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    idleController.signal.removeEventListener("abort", cancelReaderOnAbort);
  };
  const cancelReaderOnAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  idleController.signal.addEventListener("abort", cancelReaderOnAbort, {
    once: true,
  });
  const sseFrames = createSseFrameAssembler();

  try {
    while (true) {
      options.signal?.throwIfAborted();
      if (idleController.signal.aborted) {
        throw new Error("Stream aborted");
      }
      const { done, value } = await readWithAbort(
        reader,
        idleController.signal,
      );
      options.signal?.throwIfAborted();
      if (idleController.signal.aborted) {
        throw new Error("Stream aborted");
      }
      if (done) break;
      // Bytes off the wire re-arm the watchdog before anything is parsed.
      // Keepalives and empty deltas are proof of a live connection, so they
      // must not be allowed to age out a stream that is merely quiet.
      if (value && value.byteLength > 0) noteTransportActivity();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = sseFrames.pushLine(line);
        if (payload === undefined) continue;
        if (payload === "[DONE]") {
          terminalSignal = "done-sentinel";
          requireTerminalProof({
            provider: options.provider,
            policy: terminalPolicy,
            signal: terminalSignal,
            ...emittedByteCounts(),
          });
          flushEchoBuffer();
          cleanup();
          const toolCalls = finalizeOpenAiToolCalls(toolCallState);
          emitPrivateReasoningNote(toolCalls.length > 0);
          const reasoningArtifacts = finalReasoningArtifacts(toolCalls);
          emitStreamReasoningArtifacts(
            options.onStreamEvent,
            reasoningArtifacts,
          );
          if (!visible.trim() && toolCalls.length === 0) {
            // Thinking models (Kimi/Moonshot via Mantle, etc.) often emit only
            // reasoning, sometimes with tool sentinels inside <think>. Returning
            // the full text lets the agent runner recover tool calls from
            // thinkContent instead of failing the whole stream as an error.
            if (reasoningSeen.trim()) {
              return {
                text: full,
                ...(finishReason ? { finishReason } : { finishReason: "stop" }),
                ...(streamUsage ? { usage: streamUsage } : {}),
                ...(displayReasoningText()
                  ? { reasoningBlock: { text: displayReasoningText() } }
                  : {}),
                ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
              };
            }
            throw new ProviderError(
              `${options.provider} completed without a visible answer.`,
            );
          }
          return {
            text: full,
            ...(toolCalls.length ? { toolCalls } : {}),
            ...(finishReason
              ? { finishReason }
              : toolCalls.length
                ? { finishReason: "tool_calls" }
                : {}),
            ...(streamUsage ? { usage: streamUsage } : {}),
            ...(displayReasoningText()
              ? { reasoningBlock: { text: displayReasoningText() } }
              : {}),
            ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
          };
        }
        let parsed: {
          error?: { message?: string; type?: string } | string;
          usage?: unknown;
          choices?: Array<{
            finish_reason?: string;
            delta?: {
              content?: string;
              reasoning_content?: string;
              reasoning?: string;
              reasoning_details?: unknown;
              thinking?: unknown;
              thinking_signature?: string | null;
              extra_content?: { google?: { thought_signature?: string } };
              role?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: string;
                function?: {
                  name?: string;
                  arguments?: string | Record<string, unknown>;
                };
              }>;
            };
          }>;
        };
        try {
          // Only JSON.parse is allowed to fail silently here. The
          // delta handlers below (tool-arg size guard, UI callbacks) used to be
          // inside this try and had their errors swallowed as "keepalives".
          parsed = JSON.parse(payload) as typeof parsed;
        } catch {
          // Malformed keepalive / comment line.
          continue;
        }
        // Gateways report mid-stream failures as an error frame; that
        // used to be dropped, so an upstream overload looked like a complete
        // (but truncated) answer.
        if (parsed.error) {
          const detail =
            typeof parsed.error === "string"
              ? parsed.error
              : (parsed.error.message ?? parsed.error.type ?? "unknown error");
          throw new ProviderError(
            `${options.provider} stream error: ${detail}`,
            inBandBadRequestStatus(parsed.error),
            payload.slice(0, 500),
          );
        }
        {
          const chunkUsage =
            options.providerId === "fireworks"
              ? parseFireworksUsage(
                  parsed.usage,
                  (parsed as { perf_metrics?: unknown }).perf_metrics,
                  response.headers,
                )
              : parseOpenAiUsage(parsed.usage, options.usageAliases);
          if (chunkUsage) streamUsage = chunkUsage;
          const finalUsageFrame = isFinalUsageFrame(parsed);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          const reasoningToken = openAiReasoningText(delta);
          const token = delta?.content;
          const detailRaw = artifactRaw(delta?.reasoning_details);
          const thoughtSignature =
            delta?.extra_content?.google?.thought_signature;
          const artifactSequence = nextArtifactSequence++;
          const toolProgress = delta?.tool_calls?.some((toolCall) =>
            Boolean(
              toolCall.id ||
              toolCall.function?.name ||
              toolCall.function?.arguments,
            ),
          );
          if (
            choice?.finish_reason ||
            chunkUsage ||
            reasoningToken ||
            token ||
            detailRaw ||
            thoughtSignature ||
            toolProgress
          ) {
            resetIdleTimer();
          }
          if (
            terminalSignal === "usage-chunk" &&
            (token || reasoningToken || toolProgress)
          ) {
            terminalSignal = undefined;
          }
          if (choice?.finish_reason) {
            finishReason = choice.finish_reason;
            terminalSignal = "finish-reason";
          } else if (finalUsageFrame && terminalSignal === undefined) {
            terminalSignal = "usage-chunk";
          }
          if (reasoningToken) {
            const normalized = normalizeChannelDelta(
              reasoningToken,
              reasoningWireSeen,
              options.providerId === "bynara" ? 1 : 64,
            );
            reasoningWireSeen = normalized.seen;
            if (normalized.delta) {
              reasoningArtifactSequence ??= artifactSequence;
              if (!reasoningSeen) {
                learnModelEmitsReasoning(options.providerId, options.model);
              }
              reasoningSeen += normalized.delta;
              emitStreamReasoningDelta(options.onStreamEvent, normalized.delta);
            }
          }
          if (detailRaw) {
            structuredDetails.push({
              raw: detailRaw,
              sequence: artifactSequence,
            });
          }
          if (token) {
            const normalized = normalizeChannelDelta(token, contentWireSeen);
            contentWireSeen = normalized.seen;
            if (normalized.delta) handleContentToken(normalized.delta);
          }
          const deltaToolCallIndices: number[] = [];
          if (delta?.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              const accInfo = accumulateOpenAiToolCallDelta(toolCallState, tc);
              deltaToolCallIndices.push(accInfo.index);
              lastToolCallIndex = accInfo.index;
              if (options.onToolCallDelta) {
                const wire = accInfo.name;
                const canonical = wire
                  ? (fromWireName(wire) ?? wire)
                  : undefined;
                const largeArgTick =
                  !accInfo.nameBecameKnown &&
                  accInfo.argumentsBytes > 0 &&
                  accInfo.argumentsBytes % 4096 <
                    (typeof tc.function?.arguments === "string"
                      ? tc.function.arguments.length
                      : 0);
                if (accInfo.nameBecameKnown || largeArgTick) {
                  options.onToolCallDelta({
                    index: accInfo.index,
                    ...(accInfo.id !== undefined ? { id: accInfo.id } : {}),
                    ...(canonical !== undefined ? { name: canonical } : {}),
                    argumentsBytes: accInfo.argumentsBytes,
                  });
                }
              }
            }
          }
          const signatureToolCallIndex =
            deltaToolCallIndices[0] ?? lastToolCallIndex;
          if (thoughtSignature) {
            const capture = {
              raw: thoughtSignature,
              sequence: artifactSequence,
              ...(signatureToolCallIndex === undefined
                ? {}
                : { toolCallIndex: signatureToolCallIndex }),
            };
            if (signatureToolCallIndex === undefined) {
              pendingThoughtSignatures.push(capture);
            } else {
              thoughtSignatures.push(capture);
            }
          }
          if (deltaToolCallIndices.length && pendingThoughtSignatures.length) {
            const toolCallIndex = deltaToolCallIndices[0]!;
            for (const capture of pendingThoughtSignatures.splice(0)) {
              thoughtSignatures.push({ ...capture, toolCallIndex });
            }
          }
        }
      }
    }
    flushEchoBuffer();
    cleanup();
    requireTerminalProof({
      provider: options.provider,
      policy: terminalPolicy,
      signal: terminalSignal,
      ...emittedByteCounts(),
    });
    const toolCalls = finalizeOpenAiToolCalls(toolCallState);
    emitPrivateReasoningNote(toolCalls.length > 0);
    const reasoningArtifacts = finalReasoningArtifacts(toolCalls);
    emitStreamReasoningArtifacts(options.onStreamEvent, reasoningArtifacts);
    if (!visible.trim() && toolCalls.length === 0) {
      // See [DONE] branch — hand thinking-only streams to the runner so it can
      // salvage sentinel tool blocks (or nudge) instead of hard-failing.
      if (reasoningSeen.trim()) {
        return {
          text: full,
          ...(finishReason ? { finishReason } : { finishReason: "stop" }),
          ...(streamUsage ? { usage: streamUsage } : {}),
          ...(displayReasoningText()
            ? { reasoningBlock: { text: displayReasoningText() } }
            : {}),
          ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
        };
      }
      throw new ProviderError(
        `${options.provider} completed without a visible answer.`,
      );
    }
    return {
      text: full,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(finishReason
        ? { finishReason }
        : toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(streamUsage ? { usage: streamUsage } : {}),
      ...(displayReasoningText()
        ? { reasoningBlock: { text: displayReasoningText() } }
        : {}),
      ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
    };
  } catch (error) {
    if (idleFired) {
      const seconds = Math.round(firedBudgetMs / 1000);
      // Preserve the actual watchdog source. Any byte proves the route admitted
      // the request, but a later byte-silence timeout is still a transport
      // failure; only the output watchdog denotes a live keepalive-only/model
      // stall and receives STREAM_STALL_MARKER.
      if (firedWatchdog === "transport" || !sawTransportActivity) {
        if (!sawTransportActivity) {
          // Keep the established wording: both the router's transparent-retry
          // check and classifyStreamFailure key off this phrase to treat a route
          // that never answered as a retriable transport failure.
          throw new ProviderError(
            `${options.provider} request timed out before any response (${seconds}s) — no data arrived on the connection.`,
          );
        }
        throw new ProviderError(
          `${options.provider} stream transport timeout (${seconds}s) — no data arrived on the connection after it had started.`,
        );
      }
      throw new ProviderError(
        `${options.provider} stream stalled — ${STREAM_STALL_MARKER} for ${seconds}s` +
          (sawStreamProgress
            ? " after it had already started producing output. " +
              "The connection stayed open, so the model was most likely buffering one very large tool call. " +
              "Split large writes into smaller sequential calls, or try a smaller model / disable thinking with /effort off."
            : " — the connection stayed open but the model never produced anything. " +
              "Try another model, or disable thinking with /effort off."),
      );
    }
    throw error;
  } finally {
    // The success paths used to return without releasing the body, so
    // the socket stayed locked until GC — dozens of leaked connections per
    // long agent turn.
    cleanup();
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}
