import type {
  ChatMessage,
  ProviderId,
  ReasoningArtifactReplayObserver,
  ReasoningArtifactReplayTarget,
  ReasoningPreference,
  ToolChoice,
  ToolDefinition,
} from "../../types.js";
import {
  openAiToolBodyFields,
  toOpenAiToolMessages,
} from "../adapters/openai-tools.js";
import { cacheAffinityKey, sessionCacheAffinityKey } from "../cache-affinity.js";
import { currentSessionAffinity } from "../session-affinity.js";
import {
  isReasoningUnsupported,
  modelSupportsThinking,
} from "../capabilities.js";
import { modelMaxOutputTokens } from "../context-windows.js";
import type { RequestPlanV1 } from "../request-plan.js";
import { resolveSampling } from "../sampling.js";
import { singleLeadingSystemMessages } from "../system-messages.js";
import {
  buildReasoningPayload,
  ReasoningControlContext,
  ReasoningStyle,
} from "./reasoning-payload.js";

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

export function toOpenAiMessages(
  messages: ChatMessage[],
  supportsVision = true,
  replay?: {
    target: ReasoningArtifactReplayTarget;
    observe?: ReasoningArtifactReplayObserver | undefined;
    forceScope?: boolean | undefined;
  },
): Array<Record<string, unknown>> {
  return toOpenAiToolMessages(
    messages,
    (message) => {
      if (supportsVision && message.images && message.images.length > 0) {
        const parts: OpenAiContentPart[] = [];
        if (message.content)
          parts.push({ type: "text", text: message.content });
        for (const img of message.images) {
          parts.push({
            type: "image_url",
            image_url: {
              url: `data:${img.mediaType};base64,${img.dataBase64}`,
              detail: "high",
            },
          });
        }
        return parts;
      }
      return message.content;
    },
    replay,
  ) as Array<Record<string, unknown>>;
}

export function isOpenAiReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    /(?:^|\/)gpt-5(?:\.|-|$)/.test(m) ||
    /(?:^|\/)o[134](?:\.|-|$)/.test(m) ||
    /muse-spark/.test(m)
  );
}

export interface ChatCompletionsBodyOptions {
  model: string;
  providerId?: ProviderId | undefined;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  stream: boolean;
  includeStreamUsage?: boolean | undefined;
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
  supportsVision?: boolean | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  replayTarget?: ReasoningArtifactReplayTarget | undefined;
  reasoningArtifactReplayObserver?: ReasoningArtifactReplayObserver | undefined;
  forceReasoningReplay?: boolean | undefined;
  control?: ReasoningControlContext | undefined;
  outputTokenLimit?: number | undefined;
  resolvedSampling?:
    | {
        readonly temperature?: number | undefined;
        readonly topP?: number | undefined;
      }
    | undefined;
}

const DEFAULT_REASONING_OUTPUT_FLOOR = 16_384;

function outputBudgetWithReasoning(
  requested: number,
  options: ChatCompletionsBodyOptions,
): number {
  const floor =
    options.control?.profile.reasoning.minOutputTokens ??
    DEFAULT_REASONING_OUTPUT_FLOOR;
  const ceiling = modelMaxOutputTokens(
    options.providerId,
    options.model,
    options.outputTokenLimit,
  );
  const floored = Math.max(requested, floor);
  return ceiling !== undefined ? Math.min(floored, ceiling) : floored;
}

function emitChatCompletionsBody(options: ChatCompletionsBodyOptions): string {
  const capabilityDeniesThinking =
    options.control === undefined &&
    options.providerId !== undefined &&
    Boolean(options.reasoning?.enabled) &&
    !modelSupportsThinking(options.providerId, options.model);
  const legacyControlDenied =
    options.control === undefined &&
    options.providerId !== undefined &&
    isReasoningUnsupported(options.providerId, options.model);
  const reasoning =
    legacyControlDenied ||
    capabilityDeniesThinking ||
    options.control?.suppressed === true
      ? {}
      : buildReasoningPayload(
          options.reasoning,
          options.reasoningStyle ?? "none",
          options.model,
          options.providerId,
          options.control,
        );

  const reasoningOn = Boolean(options.reasoning?.enabled);
  const isMinimaxM3 = /minimax-m3/i.test(options.model);
  const defaultMaxTokens = isMinimaxM3 ? 8_192 : reasoningOn ? 8_192 : 4_096;
  const sampling = options.resolvedSampling ?? {
    ...resolveSampling({
      model: options.model,
      reasoningEnabled: reasoningOn,
      requestedTemperature: options.temperature,
    }),
  };
  const reasoningModel = isOpenAiReasoningModel(options.model);
  const emitTemperature =
    sampling.temperature !== undefined &&
    (options.resolvedSampling !== undefined || !reasoningModel);
  const claudeThinking =
    reasoningOn &&
    options.reasoningStyle === "agentrouter" &&
    /claude/i.test(options.model);
  const requestedMaxTokens = options.maxTokens ?? defaultMaxTokens;
  const claudeFloored = claudeThinking
    ? Math.max(requestedMaxTokens, 32_000)
    : requestedMaxTokens;
  const effectiveMaxTokens = reasoningOn
    ? outputBudgetWithReasoning(claudeFloored, options)
    : claudeFloored;
  const affinitySession = currentSessionAffinity();
  const affinityKey =
    options.providerId === "openrouter" ||
    options.providerId === "fireworks" ||
    options.providerId === "merge-gateway"
      ? affinitySession
        ? sessionCacheAffinityKey(affinitySession)
        : cacheAffinityKey(options.providerId, options.model, options.messages)
      : undefined;
  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOpenAiMessages(
      singleLeadingSystemMessages(options.messages),
      options.supportsVision,
      options.replayTarget
        ? {
            target: options.replayTarget,
            observe: options.reasoningArtifactReplayObserver,
            ...(options.forceReasoningReplay ? { forceScope: true } : {}),
          }
        : undefined,
    ),
    stream: options.stream,
    ...((options.providerId === "openrouter" ||
      options.providerId === "merge-gateway") &&
    affinityKey
      ? { session_id: affinityKey }
      : {}),
    ...(options.providerId === "fireworks"
      ? {
          perf_metrics_in_response: true,
          ...(affinityKey
            ? {
                prompt_cache_key: affinityKey,
                prompt_cache_isolation_key: affinityKey,
              }
            : {}),
        }
      : {}),
    ...(reasoningModel
      ? { max_completion_tokens: effectiveMaxTokens }
      : { max_tokens: effectiveMaxTokens }),
    ...(emitTemperature ? { temperature: sampling.temperature } : {}),
    ...reasoning,
    ...openAiToolBodyFields({
      tools: options.tools,
      toolChoice: options.toolChoice,
      parallelToolCalls: options.parallelToolCalls,
    }),
  };
  if (emitTemperature && sampling.topP !== undefined) {
    body.top_p = sampling.topP;
  }
  if (options.stream && options.includeStreamUsage !== false) {
    body.stream_options = { include_usage: true };
  }
  return JSON.stringify(body);
}

export function buildChatBody(options: ChatCompletionsBodyOptions): string {
  return emitChatCompletionsBody(options);
}

export function chatCompletionsBodyFromPlan(
  plan: RequestPlanV1,
  extras: {
    reasoningStyle?: ReasoningStyle | undefined;
    includeStreamUsage?: boolean | undefined;
    reasoningArtifactReplayObserver?:
      ReasoningArtifactReplayObserver | undefined;
    forceReasoningReplay?: boolean | undefined;
  } = {},
): string {
  return emitChatCompletionsBody({
    model: plan.route.model,
    providerId: plan.route.provider,
    messages: [...plan.timeline.messages],
    maxTokens: plan.controls.requestedMaxTokens,
    temperature: plan.controls.temperature,
    stream: plan.controls.stream,
    includeStreamUsage: extras.includeStreamUsage,
    reasoning: plan.controls.reasoning,
    reasoningStyle: extras.reasoningStyle,
    supportsVision: plan.images.visionAccepted,
    control: {
      profile: {
        reasoning: plan.policy.reasoning,
        capabilities: { acceptedParameters: plan.policy.acceptedParameters },
      },
      willReplayReasoning: plan.replay.decisions.some(
        (entry) => entry.decision.action === "replayed",
      ),
      suppressed: plan.controls.controlSuppression !== undefined,
    },
    resolvedSampling: {
      temperature: plan.controls.temperature,
      topP: plan.controls.topP,
    },
    ...(plan.policy.limits.outputTokens !== undefined
      ? { outputTokenLimit: plan.policy.limits.outputTokens }
      : {}),
    tools: plan.tools.definitions.length
      ? [...plan.tools.definitions]
      : undefined,
    toolChoice: plan.tools.choice,
    parallelToolCalls: plan.tools.parallelToolCalls,
    replayTarget: plan.replay.target,
    reasoningArtifactReplayObserver: extras.reasoningArtifactReplayObserver,
    ...(extras.forceReasoningReplay ? { forceReasoningReplay: true } : {}),
  });
}
