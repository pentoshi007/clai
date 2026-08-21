import type {
  CompletionRequest,
  CompletionResult,
  ReasoningPreference,
} from "../types.js";
import {
  defaultModels,
  type LlmProvider,
  type ProviderAuth,
} from "./provider.js";
import {
  ProviderError,
  createSseFrameAssembler,
  imageCapableMessages,
  readJson,
  readStreamLines,
  streamIdleBudgets,
} from "./http.js";
import {
  anthropicToolBodyFields,
  createAnthropicToolStreamState,
  finalizeAnthropicToolStream,
  handleAnthropicStreamEvent,
  parseAnthropicToolUseBlocks,
  toAnthropicToolMessages,
} from "./adapters/anthropic-tools.js";
import {
  mergeAnthropicStreamUsage,
  parseAnthropicUsage,
  withReasoningObservation,
} from "./token-usage.js";
import { generationFetch } from "./operation-usage.js";
import {
  firstSystemPrompt,
  requestContextSystemPrompts,
  withoutRequestContextSystemMessages,
} from "./system-messages.js";
import { resolveSampling } from "./sampling.js";
import {
  emitStreamReasoningArtifacts,
  emitStreamReasoningDelta,
} from "./stream-events.js";
import { ANTHROPIC_STREAM_TERMINAL, requireTerminalProof } from "./stream-terminal.js";
import type { TokenUsage } from "../types.js";
import {
  createReasoningArtifactProvenance,
  createSignedThinkingArtifacts,
} from "./reasoning-artifacts.js";
import { compileRequestPlan } from "./request-plan.js";
import type { AnthropicThinkingBlock } from "./adapters/anthropic-tools.js";

const baseUrl = "https://api.anthropic.com/v1";
const anthropicVersion = "2023-06-01";

function anthropicReasoningArtifacts(
  model: string,
  blocks: readonly AnthropicThinkingBlock[],
) {
  const artifacts = createSignedThinkingArtifacts({
    blocks,
    provenance: createReasoningArtifactProvenance({
      provider: "anthropic",
      model,
      dialect: "anthropic-messages",
      endpoint: baseUrl,
    }),
  });
  return artifacts.length ? artifacts : undefined;
}

function anthropicThinkingBudget(
  reasoning: ReasoningPreference | undefined,
): number | undefined {
  if (!reasoning?.enabled) return undefined;
  switch (reasoning.effort) {
    case "low":
      return 1_024;
    case "high":
    case "xhigh":
    case "max":
      return 8_192;
    default:
      return 4_096;
  }
}

/**
 * Claude Opus 4.7+ and later generations (Sonnet 5, Opus 4.8, …) removed
 * manual extended thinking (`thinking: {type:"enabled", budget_tokens}`) —
 * it now returns HTTP 400. Those models require adaptive thinking
 * (`thinking: {type:"adaptive"}` + `effort`) instead. Earlier models
 * (3-7, 4, 4-5, 4-6) still use the legacy budget_tokens form.
 * https://docs.anthropic.com/en/docs/about-claude/models/extended-thinking-models
 */
function requiresAdaptiveThinking(model: string): boolean {
  return /claude-(?:opus|sonnet|haiku)-(?:4-[7-9]|4-\d\d|5(?:-|$))/i.test(model);
}

function anthropicThinkingField(
  reasoning: ReasoningPreference | undefined,
  model: string,
): Record<string, unknown> | undefined {
  if (!reasoning?.enabled) return undefined;
  if (requiresAdaptiveThinking(model)) {
    return { type: "adaptive", effort: reasoning.effort ?? "medium" };
  }
  const budget = anthropicThinkingBudget(reasoning);
  if (budget === undefined) return undefined;
  return { type: "enabled", budget_tokens: budget };
}

/** Output cap that always clears the requested thinking budget. */
export function anthropicMaxTokens(
  requested: number | undefined,
  thinking: Record<string, unknown> | undefined,
): number {
  const budget =
    typeof thinking?.budget_tokens === "number" ? thinking.budget_tokens : 0;
  return Math.max(requested ?? 8_192, budget + 1_024);
}

// Minimum prompt length worth a cache breakpoint. Below Anthropic's own cache
// floor the marker only adds cache-write cost.
const CACHE_BREAKPOINT_MIN_CHARS = 4_000;

/**
 * Mark the end of the stable system prefix as a cache breakpoint. Anthropic's
 * cache render order is tools → system → messages, so this single breakpoint
 * caches both unchanged native tool schemas and the constitution. Mutable
 * request/workspace/plan state is carried only in later messages.
 */
export function anthropicSystemBlocks(
  system: string | undefined,
  requestContexts: readonly string[] = [],
): string | Array<Record<string, unknown>> | undefined {
  if (!system && requestContexts.length === 0) return undefined;
  if (system && system.length < CACHE_BREAKPOINT_MIN_CHARS && requestContexts.length === 0) {
    return system;
  }
  const blocks: Array<Record<string, unknown>> = [];
  if (system) {
    blocks.push({
      type: "text",
      text: system,
      ...(system.length >= CACHE_BREAKPOINT_MIN_CHARS
        ? { cache_control: { type: "ephemeral" } }
        : {}),
    });
  }
  for (const text of requestContexts) {
    blocks.push({ type: "text", text });
  }
  return blocks;
}

export function buildAnthropicBody(request: CompletionRequest, stream: boolean): string {
  const model = request.model ?? defaultModels.anthropic;
  const plan = compileRequestPlan({
    provider: "anthropic",
    model,
    messages: request.messages,
    stream,
    endpoint: baseUrl,
    reasoning: request.thinking,
    tools: request.tools,
    toolChoice: request.toolChoice,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
  });
  const requestContexts = requestContextSystemPrompts(request.messages);
  const system = anthropicSystemBlocks(
    firstSystemPrompt(request.messages),
    requestContexts,
  );
  const reasoningArtifactReplay = {
    target: plan.replay.target,
    observe: request.onReasoningArtifactReplayDecision,
  };
  const messages = toAnthropicToolMessages(
    withoutRequestContextSystemMessages(
      imageCapableMessages("anthropic", model, [...plan.timeline.messages]),
    ),
    reasoningArtifactReplay,
  );
  const thinking = anthropicThinkingField(plan.controls.reasoning, model);
  return JSON.stringify({
    model,
    system,
    messages,
    cache_control: { type: "ephemeral" },
    // A 1024 default sits below `anthropicThinkingBudget` (up to 8192), which
    // Anthropic rejects outright, and is far below every Claude output cap.
    max_tokens: anthropicMaxTokens(plan.controls.requestedMaxTokens, thinking),
    // Anthropic requires temperature to stay at its default (1) whenever
    // thinking is enabled — sending our 0.2 default returns HTTP 400
    // ("temperature may only be set to 1 when thinking is enabled").
    // Omit the field in that case rather than pin it to 1 explicitly, since
    // some non-thinking-capable models on the same body path (e.g. Haiku
    // 3.5) still support a real temperature.
    ...(thinking
      ? {}
      : {
          temperature: resolveSampling({
            provider: "anthropic",
            model,
            reasoningEnabled: Boolean(plan.controls.reasoning?.enabled),
            requestedTemperature: plan.controls.temperature,
          }).temperature,
        }),
    ...(stream ? { stream: true } : {}),
    ...(thinking ? { thinking } : {}),
    ...anthropicToolBodyFields({
      tools: plan.tools.definitions.length
        ? [...plan.tools.definitions]
        : undefined,
      toolChoice: plan.tools.choice,
    }),
  });
}

export const anthropicProvider: LlmProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  defaultModel: defaultModels.anthropic,
  envVar: "ANTHROPIC_API_KEY",
  validateKey: (key: string) => /^sk-ant-[A-Za-z0-9_-]{12,}$/.test(key),
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Anthropic API key is required");
    const response = await fetch(`${baseUrl}/models`, {
      headers: {
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
    });
    await readJson<unknown>(response);
  },
  async complete(
    request: CompletionRequest,
    auth: ProviderAuth,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Anthropic API key is required");
    const model = request.model ?? defaultModels.anthropic;
    const response = await generationFetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
      body: buildAnthropicBody(request, false),
    });
    const data = await readJson<{
      content?: Array<{
        type: string;
        text?: string;
        thinking?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      stop_reason?: string;
      usage?: unknown;
    }>(response);
    const parsed = parseAnthropicToolUseBlocks(data.content);
    if (!parsed.text && parsed.toolCalls.length === 0) {
      throw new Error("Anthropic returned no completion text");
    }
    const reasoningBlock =
      parsed.thinkingSignature && parsed.thinkingText
        ? { text: parsed.thinkingText, signature: parsed.thinkingSignature }
        : undefined;
    const reasoningArtifacts = anthropicReasoningArtifacts(
      model,
      parsed.thinkingBlocks,
    );
    const usage = withReasoningObservation(
      parseAnthropicUsage(data.usage),
      Boolean(parsed.thinkingText.trim()),
    );
    return {
      text: parsed.text,
      provider: "anthropic",
      model,
      ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      ...(reasoningBlock ? { reasoningBlock } : {}),
      ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
      ...(data.stop_reason
        ? {
            finishReason:
              data.stop_reason === "tool_use" ? "tool_calls" : data.stop_reason,
          }
        : parsed.toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(usage ? { usage } : {}),
    };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Anthropic API key is required");
    const model = request.model ?? defaultModels.anthropic;
    const response = await generationFetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
      body: buildAnthropicBody(request, true),
    });
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Anthropic returned no stream body");
    }
    let full = "";
    const streamState = createAnthropicToolStreamState();
    let stopReason: string | undefined;
    let sawMessageStop = false;
    let streamUsage: TokenUsage | undefined;

    const sseFrames = createSseFrameAssembler();
    let outputProgress = 0;
    const toolArgumentBytes = new Map<number, number>();
    for await (const line of readStreamLines(response, {
      signal: request.signal,
      ...streamIdleBudgets(Boolean(request.thinking?.enabled)),
      outputProgress: () => outputProgress,
    })) {
      const payload = sseFrames.pushLine(line);
      if (payload === undefined) continue;
      if (payload === "[DONE]") break;
      try {
        const parsed = JSON.parse(payload) as {
          type?: string;
          index?: number;
          error?: { message?: string; type?: string };
          usage?: unknown;
          message?: { usage?: unknown };
          content_block?: {
            type?: string;
            id?: string;
            name?: string;
            text?: string;
            thinking?: string;
            signature?: string;
          };
          delta?: {
            type?: string;
            text?: string;
            thinking?: string;
            signature?: string;
            partial_json?: string;
            stop_reason?: string;
          };
        };
        // Anthropic reports mid-stream overloads as an `error` event.
        // It used to be dropped, so a truncated answer looked complete.
        if (parsed.type === "error") {
          throw new ProviderError(
            `Anthropic stream error: ${parsed.error?.message ?? parsed.error?.type ?? "unknown"}`,
            undefined,
            payload.slice(0, 500),
          );
        }
        if (parsed.type === "message_stop") sawMessageStop = true;
        // message_start carries input tokens; message_delta carries output.
        if (parsed.type === "message_start" && parsed.message?.usage) {
          streamUsage = parseAnthropicUsage(parsed.message.usage) ?? streamUsage;
        }
        if (parsed.type === "message_delta") {
          if (parsed.delta?.stop_reason) {
            stopReason = parsed.delta.stop_reason;
          }
          if (parsed.usage) {
            const out = parseAnthropicUsage(parsed.usage);
            if (out) {
              streamUsage = mergeAnthropicStreamUsage(streamUsage, out);
            }
          }
        }
        if (
          parsed.type === "content_block_start" ||
          parsed.type === "content_block_delta"
        ) {
          const deltas = handleAnthropicStreamEvent(streamState, parsed);
          if (deltas.thinkingDelta) {
            outputProgress += deltas.thinkingDelta.length;
            emitStreamReasoningDelta(request.onStreamEvent, deltas.thinkingDelta);
          }
          if (deltas.textDelta) {
            full += deltas.textDelta;
            outputProgress += deltas.textDelta.length;
            onToken(deltas.textDelta);
          }
          if (deltas.toolCallDelta) {
            const { index, argumentsBytes } = deltas.toolCallDelta;
            const seen = toolArgumentBytes.get(index) ?? 0;
            const next = Math.max(seen, argumentsBytes ?? seen + 1);
            if (next > seen) {
              toolArgumentBytes.set(index, next);
              outputProgress += next - seen;
            }
          }
          if (deltas.toolCallDelta && request.onToolCallDelta) {
            const d = deltas.toolCallDelta;
            request.onToolCallDelta({
              index: d.index,
              ...(d.id !== undefined ? { id: d.id } : {}),
              ...(d.name !== undefined ? { name: d.name } : {}),
              ...(d.argumentsBytes !== undefined
                ? { argumentsBytes: d.argumentsBytes }
                : {}),
            });
          }
        }
      } catch (frameError) {
        // Only a malformed JSON frame is ignorable; real errors (provider error
        // Frames, tool-argument size guard) must propagate.
        if (!(frameError instanceof SyntaxError)) throw frameError;
      }
    }
    const finalized = finalizeAnthropicToolStream(streamState);
    let anthropicToolArgumentBytes = 0;
    for (const value of toolArgumentBytes.values()) {
      anthropicToolArgumentBytes += value;
    }
    requireTerminalProof({
      provider: "Anthropic",
      policy: ANTHROPIC_STREAM_TERMINAL,
      signal: sawMessageStop ? "message-stop" : undefined,
      answerBytes: full.length,
      reasoningBytes: finalized.thinkingText.length,
      toolArgumentBytes: anthropicToolArgumentBytes,
    });
    const reasoningArtifacts = anthropicReasoningArtifacts(
      model,
      finalized.thinkingBlocks,
    );
    emitStreamReasoningArtifacts(request.onStreamEvent, reasoningArtifacts);
    if (
      !full.trim() &&
      !finalized.thinkingText &&
      finalized.toolCalls.length === 0
    ) {
      throw new Error("Anthropic returned no completion text");
    }
    const usage = withReasoningObservation(
      streamUsage,
      Boolean(finalized.thinkingText.trim()),
    );
    return {
      text: full,
      provider: "anthropic",
      model,
      ...(finalized.toolCalls.length
        ? { toolCalls: finalized.toolCalls }
        : {}),
      ...(finalized.thinkingSignature && finalized.thinkingText
        ? {
            reasoningBlock: {
              text: finalized.thinkingText,
              signature: finalized.thinkingSignature,
            },
          }
        : {}),
      ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
      ...(stopReason
        ? {
            finishReason:
              stopReason === "tool_use" ? "tool_calls" : stopReason,
          }
        : finalized.toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(usage ? { usage } : {}),
    };
  },
};
