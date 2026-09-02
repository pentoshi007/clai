import type {
  ChatMessage,
  NativeToolCall,
  ToolCallStreamDelta,
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
import { openAiCompatibleStreamViaResponses } from "./responses-first.js";
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
  includeStreamUsage?: boolean | undefined;
  usageAliases?: CompatibleUsageAliases | undefined;
  reasoningArtifactPolicy?: CompatibleReasoningArtifactPolicy | undefined;
  reasoningArtifactReplayObserver?: ReasoningArtifactReplayObserver | undefined;
  forceReasoningReplay?: boolean | undefined;
  onToolCallDelta?: ((delta: ToolCallStreamDelta) => void) | undefined;
  idleTimeoutMs?: number | undefined;

  initialIdleTimeoutMs?: number | undefined;
  outputIdleTimeoutMs?: number | undefined;
  responsesFirst?: boolean | undefined;
}): Promise<OpenAiCompatibleResult> {
  const viaResponses = options.responsesFirst
    ? await openAiCompatibleStreamViaResponses(options, {
        onToken: options.onToken,
        ...(options.onToolCallDelta
          ? { onToolCallDelta: options.onToolCallDelta }
          : {}),
        ...(options.onStreamEvent ? { onStreamEvent: options.onStreamEvent } : {}),
      })
    : undefined;
  if (viaResponses) return { ...viaResponses, api: "responses" };
  const reasoningOn = Boolean(options.reasoning?.enabled);
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    (reasoningOn
      ? THINKING_STREAM_IDLE_TIMEOUT_MS
      : DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  const initialIdleTimeoutMs =
    options.initialIdleTimeoutMs ??
    (reasoningOn ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS : idleTimeoutMs);
  const outputIdleTimeoutMs =
    options.outputIdleTimeoutMs ??
    Math.round(Math.max(idleTimeoutMs, initialIdleTimeoutMs) * 1.5);
  const idleController = new AbortController();
  let transportTimer: NodeJS.Timeout | undefined;
  let outputTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  let firedWatchdog: "transport" | "output" | undefined;
  let firedBudgetMs = initialIdleTimeoutMs;
  let sawTransportActivity = false;
  let sawStreamProgress = false;
  const fireStall = (
    watchdog: "transport" | "output",
    budgetMs: number,
  ): void => {
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
          api: "chat-completions",
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
    if (!reasoningOn) return undefined;
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
    if (!reasoningOn) return "";
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
    if (!reasoningOn) return;
    if (reasoningSeen.trim()) return;
    if (!visible.trim() && !hasToolCalls) return;
    const tokens = streamUsage?.reasoningTokens ?? 0;
    if (tokens <= 0) return;
    const note = privateReasoningNote(options.provider, requestBody, tokens);
    emitStreamReasoningDelta(options.onStreamEvent, note);
  };

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
  const emitReasoningEcho = (text: string): void => {
    if (!text) return;
    emitStreamReasoningDelta(options.onStreamEvent, text);
  };
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
            if (reasoningSeen.trim()) {
              return {
                text: full,
                api: "chat-completions",
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
            api: "chat-completions",
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
          parsed = JSON.parse(payload) as typeof parsed;
        } catch {
          continue;
        }
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
          if (reasoningToken && reasoningOn) {
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
          if (detailRaw && reasoningOn) {
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
          if (thoughtSignature && reasoningOn) {
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
      if (reasoningSeen.trim()) {
        return {
          text: full,
          api: "chat-completions",
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
      api: "chat-completions",
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
    cleanup();
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
    }
  }
}
