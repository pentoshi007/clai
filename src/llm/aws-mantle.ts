import type {
  ChatMessage,
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
  openAiCompatibleComplete,
  openAiCompatibleStream,
  toCompletionResult,
  readJson,
  readStreamLines,
  ProviderError,
  createSseFrameAssembler,
  imageCapableMessages,
  ingestOpenAiModelCatalog,
  streamIdleBudgets,
} from "./http.js";
import { generationFetch } from "./operation-usage.js";
import {
  anthropicToolBodyFields,
  createAnthropicToolStreamState,
  finalizeAnthropicToolStream,
  handleAnthropicStreamEvent,
  parseAnthropicToolUseBlocks,
  toAnthropicToolMessages,
} from "./adapters/anthropic-tools.js";
import {
  firstSystemPrompt,
  requestContextSystemPrompts,
  withoutRequestContextSystemMessages,
} from "./system-messages.js";
import { anthropicMaxTokens } from "./anthropic.js";
import {
  emitStreamReasoningArtifacts,
  emitStreamReasoningDelta,
} from "./stream-events.js";
import { ANTHROPIC_STREAM_TERMINAL, requireTerminalProof } from "./stream-terminal.js";
import {
  mergeAnthropicStreamUsage,
  parseAnthropicUsage,
} from "./token-usage.js";
import type { TokenUsage } from "../types.js";
import {
  createReasoningArtifactProvenance,
  createReasoningArtifactReplayTarget,
  createSignedThinkingArtifacts,
} from "./reasoning-artifacts.js";
import type { AnthropicThinkingBlock } from "./adapters/anthropic-tools.js";

const baseUrl = "https://bedrock-mantle.ap-south-1.api.aws/anthropic/v1";
const openAiBaseUrl = "https://bedrock-mantle.ap-south-1.api.aws/v1";
const modelsBaseUrl = "https://bedrock-mantle.ap-south-1.api.aws";
const anthropicVersion = "2023-06-01";

function mantleAnthropicReasoningArtifacts(
  model: string,
  blocks: readonly AnthropicThinkingBlock[],
) {
  const artifacts = createSignedThinkingArtifacts({
    blocks,
    provenance: createReasoningArtifactProvenance({
      provider: "aws-mantle",
      model,
      dialect: "anthropic-messages",
      endpoint: baseUrl,
    }),
  });
  return artifacts.length ? artifacts : undefined;
}

function getWorkspaceId(): string {
  return process.env.ANTHROPIC_WORKSPACE_ID ?? "default";
}

function anthropicThinkingBudget(reasoning: ReasoningPreference | undefined): number | undefined {
  if (!reasoning?.enabled) return undefined;
  switch (reasoning.effort) {
    case "low":
      return 1_024;
    case "high":
      return 8_192;
    default:
      return 4_096;
  }
}

/** See anthropic.ts — Opus 4.7+ / Sonnet 5+ require adaptive thinking. */
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

function isAnthropicMantleModel(model: string): boolean {
  return /(?:^|[./-])(?:anthropic|claude)(?:[./-]|$)/i.test(model);
}

export const mantleProvider: LlmProvider = {
  id: "aws-mantle",
  reasoningStyle: "nvidia",
  displayName: "AWS Mantle",
  defaultModel: defaultModels["aws-mantle"],
  envVar: "ANTHROPIC_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9+/=_-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const response = await fetch(`${modelsBaseUrl}/v1/models`, {
      headers: {
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
      },
    });
    const data = await readJson<
      | Array<{ id?: string } | string>
      | { data?: Array<{ id?: string } | string>; models?: Array<{ id?: string } | string> }
    >(response);
    return ingestOpenAiModelCatalog("aws-mantle", data);
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const response = await fetch(`${modelsBaseUrl}/v1/models`, {
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
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const model = request.model ?? defaultModels["aws-mantle"];
    if (!isAnthropicMantleModel(model)) {
      const payload = await openAiCompatibleComplete({
        provider: "AWS Mantle",
        providerId: "aws-mantle",
        baseUrl: openAiBaseUrl,
        apiKey: auth.apiKey,
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        signal: request.signal,
        reasoning: request.thinking,
        reasoningStyle: "nvidia",
        tools: request.tools,
        toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
      });
      return toCompletionResult("aws-mantle", model, payload);
    }
    const system = [
      firstSystemPrompt(request.messages),
      ...requestContextSystemPrompts(request.messages),
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const reasoningArtifactReplay = {
      target: createReasoningArtifactReplayTarget({
        provider: "aws-mantle",
        model,
        dialect: "anthropic-messages",
        endpoint: baseUrl,
      }),
      observe: request.onReasoningArtifactReplayDecision,
    };
    const messages = toAnthropicToolMessages(
      withoutRequestContextSystemMessages(
        imageCapableMessages("aws-mantle", model, request.messages),
      ),
      reasoningArtifactReplay,
    );
    const thinking = anthropicThinkingField(request.thinking, model);
    const response = await generationFetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
        "anthropic-workspace-id": getWorkspaceId(),
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        max_tokens: anthropicMaxTokens(request.maxTokens, thinking),
        // See anthropic.ts: temperature must stay default when thinking is on.
        ...(thinking ? {} : { temperature: request.temperature ?? 0.2 }),
        ...anthropicToolBodyFields({
          tools: request.tools,
          toolChoice: request.toolChoice,
        }),
        ...(thinking ? { thinking } : {}),
      }),
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
    const usage = parseAnthropicUsage(data.usage);
    const parsed = parseAnthropicToolUseBlocks(data.content);
    if (!parsed.text && parsed.toolCalls.length === 0) {
      throw new Error("Mantle returned no completion text");
    }
    const reasoningBlock =
      parsed.thinkingSignature && parsed.thinkingText
        ? { text: parsed.thinkingText, signature: parsed.thinkingSignature }
        : undefined;
    const reasoningArtifacts = mantleAnthropicReasoningArtifacts(
      model,
      parsed.thinkingBlocks,
    );
    return {
      text: parsed.text,
      provider: "aws-mantle",
      model,
      ...(usage ? { usage } : {}),
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
    };
  },
  async stream(
    request: CompletionRequest,
    auth: ProviderAuth,
    onToken: (token: string) => void,
  ): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Mantle API key is required");
    const model = request.model ?? defaultModels["aws-mantle"];
    if (!isAnthropicMantleModel(model)) {
      const payload = await openAiCompatibleStream({
        provider: "AWS Mantle",
        providerId: "aws-mantle",
        baseUrl: openAiBaseUrl,
        apiKey: auth.apiKey,
        model,
        messages: request.messages,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        signal: request.signal,
        onToken,
      onToolCallDelta: request.onToolCallDelta,
      onStreamEvent: request.onStreamEvent,
        reasoning: request.thinking,
        reasoningStyle: "nvidia",
        tools: request.tools,
        toolChoice: request.toolChoice,
        parallelToolCalls: request.parallelToolCalls,
        reasoningArtifactReplayObserver: request.onReasoningArtifactReplayDecision,
        ...(request.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
      });
      return toCompletionResult("aws-mantle", model, payload);
    }
    const system = [
      firstSystemPrompt(request.messages),
      ...requestContextSystemPrompts(request.messages),
    ]
      .filter((value): value is string => Boolean(value))
      .join("\n\n");
    const reasoningArtifactReplay = {
      target: createReasoningArtifactReplayTarget({
        provider: "aws-mantle",
        model,
        dialect: "anthropic-messages",
        endpoint: baseUrl,
      }),
      observe: request.onReasoningArtifactReplayDecision,
    };
    const messages = toAnthropicToolMessages(
      withoutRequestContextSystemMessages(
        imageCapableMessages("aws-mantle", model, request.messages),
      ),
      reasoningArtifactReplay,
    );
    const thinking = anthropicThinkingField(request.thinking, model);
    const response = await generationFetch(`${baseUrl}/messages`, {
      method: "POST",
      signal: request.signal ?? null,
      headers: {
        "content-type": "application/json",
        "x-api-key": auth.apiKey,
        "anthropic-version": anthropicVersion,
        "anthropic-workspace-id": getWorkspaceId(),
      },
      body: JSON.stringify({
        model,
        system,
        messages,
        max_tokens: anthropicMaxTokens(request.maxTokens, thinking),
        ...(thinking ? {} : { temperature: request.temperature ?? 0.2 }),
        ...anthropicToolBodyFields({
          tools: request.tools,
          toolChoice: request.toolChoice,
        }),
        stream: true,
        ...(thinking ? { thinking } : {}),
      }),
    });
    if (!response.ok) {
      await readJson<unknown>(response);
    }
    if (!response.body) {
      throw new Error("Mantle returned no stream body");
    }
    let full = "";
    const streamState = createAnthropicToolStreamState();
    let stopReason: string | undefined;
    let sawMessageStop = false;
    let streamUsage: TokenUsage | undefined;

    const sseFrames = createSseFrameAssembler();
    let outputProgress = 0;
    let thinkingChars = 0;
    const toolArgumentBytes = new Map<number, number>();
    for await (const line of readStreamLines(response, {
      signal: request.signal,
      ...streamIdleBudgets(Boolean(request.thinking?.enabled)),
      outputProgress: () => outputProgress + full.length + thinkingChars,
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
        // Surface mid-stream provider error frames.
        if (parsed.type === "error") {
          throw new ProviderError(
            `AWS Mantle stream error: ${parsed.error?.message ?? parsed.error?.type ?? "unknown"}`,
            undefined,
            payload.slice(0, 500),
          );
        }
        if (parsed.type === "message_stop") sawMessageStop = true;
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
            thinkingChars += deltas.thinkingDelta.length;
            emitStreamReasoningDelta(request.onStreamEvent, deltas.thinkingDelta);
          }
          if (deltas.textDelta) {
            full += deltas.textDelta;
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
        // Only malformed JSON frames are ignorable.
        if (!(frameError instanceof SyntaxError)) throw frameError;
      }
    }
    const finalized = finalizeAnthropicToolStream(streamState);
    let mantleToolArgumentBytes = 0;
    for (const value of toolArgumentBytes.values()) {
      mantleToolArgumentBytes += value;
    }
    requireTerminalProof({
      provider: "AWS Mantle",
      policy: ANTHROPIC_STREAM_TERMINAL,
      signal: sawMessageStop ? "message-stop" : undefined,
      answerBytes: full.length,
      reasoningBytes: finalized.thinkingText.length,
      toolArgumentBytes: mantleToolArgumentBytes,
    });
    const reasoningArtifacts = mantleAnthropicReasoningArtifacts(
      model,
      finalized.thinkingBlocks,
    );
    emitStreamReasoningArtifacts(request.onStreamEvent, reasoningArtifacts);
    if (
      !full.trim() &&
      !finalized.thinkingText &&
      finalized.toolCalls.length === 0
    ) {
      throw new Error("Mantle returned no completion text");
    }
    return {
      text: full,
      provider: "aws-mantle",
      model,
      ...(streamUsage ? { usage: streamUsage } : {}),
      ...(finalized.toolCalls.length ? { toolCalls: finalized.toolCalls } : {}),
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
    };
  },
};
