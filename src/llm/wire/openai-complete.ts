import type {
  ChatMessage,
  ProviderId,
  ReasoningArtifactReplayObserver,
  ReasoningPreference,
  ToolChoice,
  ToolDefinition,
} from "../../types.js";
import { learnModelEmitsReasoning } from "../capabilities.js";
import { ProviderError } from "../http.js";
import { isOperationPolicyError } from "../operation-ledger.js";
import { generationFetch } from "../operation-usage.js";
import { visibleReasoningDetailText } from "../reasoning-artifacts.js";
import { compileRequestPlan } from "../request-plan.js";
import { parseFireworksUsage, parseOpenAiUsage } from "../token-usage.js";
import type { CompatibleUsageAliases } from "../token-usage.js";
import { parseOpenAiMessageToolCalls } from "../tool-protocol.js";
import { chatCompletionsBodyFromPlan } from "./chat-body.js";
import {
  artifactRaw,
  compatibleArtifactPolicyFor,
  CompatibleReasoningArtifactPolicy,
  compatibleReasoningArtifacts,
  OpenAiCompatibleResult,
  openAiReasoningText,
} from "./reasoning-artifacts.js";
import { ReasoningStyle } from "./reasoning-payload.js";
import { readJson } from "./response-errors.js";
import { openAiCompatibleCompleteViaResponses } from "./responses-first.js";

export async function openAiCompatibleComplete(options: {
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
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  usageAliases?: CompatibleUsageAliases | undefined;
  reasoningArtifactPolicy?: CompatibleReasoningArtifactPolicy | undefined;
  reasoningArtifactReplayObserver?: ReasoningArtifactReplayObserver | undefined;
  forceReasoningReplay?: boolean | undefined;
  responsesFirst?: boolean | undefined;
}): Promise<OpenAiCompatibleResult> {
  const viaResponses = options.responsesFirst
    ? await openAiCompatibleCompleteViaResponses(options)
    : undefined;
  if (viaResponses) return { ...viaResponses, api: "responses" };
  const plan = compileRequestPlan({
    provider: options.providerId,
    model: options.model,
    messages: options.messages,
    stream: false,
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
    reasoningArtifactReplayObserver: options.reasoningArtifactReplayObserver,
    ...(options.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
  });
  let response: Response;
  try {
    response = await generationFetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      signal: options.signal ?? null,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(options.apiKey
          ? { authorization: `Bearer ${options.apiKey}` }
          : {}),
        ...options.headers,
      },
      body: requestBody,
      verbose: process.env.CLAI_VERBOSE === "true",
    } as any);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    if (isOperationPolicyError(error)) throw error;
    const msg = error instanceof Error ? error.message : String(error);
    throw new ProviderError(
      `${options.provider} request could not be sent (${msg}). Check connectivity to ${options.baseUrl}.`,
    );
  }
  let data: {
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
    usage?: unknown;
  };
  try {
    data = await readJson(response);
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
  const choice = data.choices?.[0];
  const message = choice?.message;
  const toolCalls = parseOpenAiMessageToolCalls(message?.tool_calls);
  const text = message?.content ?? "";
  if (!text && toolCalls.length === 0) {
    throw new ProviderError(
      `${options.provider} returned no completion text (model=${options.model}). The response was empty — try /effort off, raise max_tokens, or pick another model with /model.`,
    );
  }
  const usage =
    options.providerId === "fireworks"
      ? parseFireworksUsage(
          data.usage,
          (data as { perf_metrics?: unknown }).perf_metrics,
          response.headers,
        )
      : parseOpenAiUsage(data.usage, options.usageAliases);
  const reasoning = openAiReasoningText(message);
  const detailsRaw = artifactRaw(message?.reasoning_details);
  const thoughtSignature = message?.extra_content?.google?.thought_signature;
  const reasoningArtifacts = compatibleReasoningArtifacts({
    providerId: options.providerId,
    model: options.model,
    baseUrl: options.baseUrl,
    toolCalls,
    policy:
      options.reasoningArtifactPolicy ??
      compatibleArtifactPolicyFor(plan.policy.reasoning.finalTurnPreservation),
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
  if (typeof reasoning === "string" && reasoning.trim()) {
    learnModelEmitsReasoning(options.providerId, options.model);
  }
  const displayReasoning =
    typeof reasoning === "string" && reasoning
      ? reasoning
      : (visibleReasoningDetailText(detailsRaw) ?? "");
  return {
    text,
    api: "chat-completions",
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(choice?.finish_reason
      ? { finishReason: choice.finish_reason }
      : toolCalls.length
        ? { finishReason: "tool_calls" }
        : {}),
    ...(usage ? { usage } : {}),
    ...(displayReasoning ? { reasoningBlock: { text: displayReasoning } } : {}),
    ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
  };
}

export async function openAiCompatiblePing(
  baseUrl: string,
  apiKey: string,
  headers?: Record<string, string> | undefined,
): Promise<void> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    verbose: process.env.CLAI_VERBOSE === "true",
  } as any);
  await readJson<unknown>(response);
}
