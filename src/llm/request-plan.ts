import { createHash } from "node:crypto";

import type {
  ChatMessage,
  ProviderId,
  ReasoningArtifactDialect,
  ReasoningArtifactReplayDecision,
  ReasoningArtifactReplayTarget,
  ReasoningPreference,
  RequestFingerprintSerializerId,
  ToolChoice,
  ToolDefinition,
} from "../types.js";
import {
  createReasoningArtifactReplayTarget,
  reasoningArtifactReplayDecision,
  reasoningArtifactsForMessage,
} from "./reasoning-artifacts.js";
import { isRequestContextSystemMessage } from "./system-messages.js";
import {
  isReasoningUnsupported,
  modelAcceptsImages,
  modelSupportsThinking,
} from "./capabilities.js";
import { resolveSampling } from "./sampling.js";
import {
  isBuiltInProviderId,
  resolveProviderProfile,
  type CachePolicySpec,
  type ContextLimitSpec,
  type ProfileReplayScope,
  type ProfileTriState,
  type OutputBudgetPolicy,
  type ReasoningCapability,
  type ReasoningControlDialect,
  type ReasoningGeneration,
  type SamplingPolicySpec,
} from "./provider-profile.js";
import type { StreamTerminalPolicy } from "./stream-terminal.js";
import { providerWireApi, resolveBuiltInProfile } from "./provider-profiles.js";
import { clampEffortToRoute } from "./route-dialect-registry.js";
import { customProviderProfileFor } from "./custom-provider-profile.js";


export const REQUEST_PLAN_VERSION = 1 as const;
export const REQUEST_PLAN_COMPILER_VERSION = 1 as const;

export type RequestPlanSectionKind = "instructions" | "history" | "live";

export interface RequestPlanBoundary {
  readonly kind: RequestPlanSectionKind;
  readonly messageStart: number;
  readonly messageEnd: number;
  readonly messageCount: number;
}

export type RequestPlanControlSuppression =
  | "observed-rejection"
  | "capability-denied";

export interface RequestPlanControls {
  readonly reasoning?: ReasoningPreference | undefined;
  readonly controlSuppression?: RequestPlanControlSuppression | undefined;
  readonly temperature?: number | undefined;
  readonly topP?: number | undefined;
  readonly requestedMaxTokens?: number | undefined;
  readonly stream: boolean;
}

export interface RequestPlanRoute {
  readonly provider: ProviderId;
  readonly model: string;
  readonly serializer: RequestFingerprintSerializerId;
  readonly serializerVersion: 1;
  readonly compilerVersion: 1;
  // hashes only; raw endpoints, credentials, and queries never enter a plan
  readonly endpointHash?: string | undefined;
}

export interface RequestPlanArtifactDecision {
  readonly messageIndex: number;
  readonly decision: ReasoningArtifactReplayDecision;
}

export type RequestPlanCacheSectionName =
  | "instructions"
  | "tools"
  | "history"
  | "artifacts"
  | "settings";

export interface RequestPlanCacheSection {
  readonly ordinal: number;
  readonly section: RequestPlanCacheSectionName;
  readonly sha256: string;
  readonly byteLength: number;
  readonly estimatedTokens: number;
  readonly itemCount: number;
}

export interface RequestPlanCacheFingerprint {
  readonly prefixMessageCount: number;
  readonly replayedArtifactCount: number;
  readonly sections: readonly RequestPlanCacheSection[];
  readonly prefixSha256: string;
}

export interface RequestPlanRoutePolicy {
  readonly reasoningGeneration: ReasoningGeneration;
  readonly controlDialect: ReasoningControlDialect;
  readonly controlStatus: ProfileTriState;
  readonly replayScope: ProfileReplayScope;
  readonly cache: CachePolicySpec;
  readonly limits: ContextLimitSpec;
  readonly reasoning: ReasoningCapability;
  readonly sampling: SamplingPolicySpec;
  readonly outputBudget: OutputBudgetPolicy;
  readonly terminal: StreamTerminalPolicy;
  readonly acceptedParameters?: readonly string[] | undefined;
}

export interface RequestPlanV1 {
  readonly version: 1;
  readonly route: RequestPlanRoute;
  readonly timeline: {
    readonly messages: readonly ChatMessage[];
    readonly sections: readonly RequestPlanBoundary[];
    readonly mutableMessageIndexes: readonly number[];
  };
  readonly tools: {
    readonly definitions: readonly ToolDefinition[];
    readonly choice?: ToolChoice | undefined;
    readonly parallelToolCalls?: boolean | undefined;
  };
  readonly replay: {
    readonly target: ReasoningArtifactReplayTarget;
    readonly decisions: readonly RequestPlanArtifactDecision[];
  };
  readonly controls: RequestPlanControls;
  readonly images: {
    readonly visionAccepted: boolean;
    readonly imageMessageIndexes: readonly number[];
    readonly imageCount: number;
  };
  readonly policy: RequestPlanRoutePolicy;
  readonly budget: { readonly plannedAdmissions: 1 };
  readonly cache: {
    readonly policy: CachePolicySpec;
    readonly fingerprint: RequestPlanCacheFingerprint;
  };
}

export interface CompileRequestPlanInput {
  readonly provider: ProviderId;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly endpoint?: string | undefined;
  readonly reasoning?: ReasoningPreference | undefined;
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly toolChoice?: ToolChoice | undefined;
  readonly parallelToolCalls?: boolean | undefined;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
}

const REPLAY_DIALECT_BY_WIRE: Record<
  RequestFingerprintSerializerId,
  ReasoningArtifactDialect
> = {
  "chat-completions": "openai-compatible",
  "anthropic-messages": "anthropic-messages",
  "gemini-generate-content": "gemini-generate-content",
  "meta-responses": "meta-responses",
  "ollama-chat": "ollama-chat",
};

const PLAN_HASH_DOMAIN = "clai.request-plan.v1\0";

function estimateTokens(byteLength: number): number {
  return Math.ceil(byteLength / 3.3);
}

function hashParts(
  parts: readonly string[],
): { sha256: string; byteLength: number } {
  const hash = createHash("sha256").update(PLAN_HASH_DOMAIN, "utf8");
  let byteLength = 0;
  for (const part of parts) {
    const bytes = Buffer.from(part, "utf8");
    hash.update(`${bytes.length}:`, "utf8");
    hash.update(bytes);
    byteLength += bytes.length;
  }
  return { sha256: hash.digest("hex"), byteLength };
}

function instructionsEnd(messages: readonly ChatMessage[]): number {
  let index = 0;
  while (index < messages.length && messages[index]!.role === "system") {
    index += 1;
  }
  return index;
}

function liveStart(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === "user") return index;
  }
  return messages.length;
}

function cacheAffectingValue(
  field: string,
  controls: {
    reasoningEnabled: boolean;
    effort: string;
    temperature?: number | undefined;
    topP?: number | undefined;
  },
): string {
  switch (field) {
    case "messages":
    case "tools":
      return `${field}-section`;
    case "thinking":
      return `${controls.reasoningEnabled}:${controls.effort}`;
    case "reasoning":
      return controls.reasoningEnabled ? "enabled" : "omitted";
    case "reasoning_effort":
    case "reasoning.effort":
      return controls.reasoningEnabled ? controls.effort : "off";
    case "temperature":
      return String(controls.temperature);
    case "top_p":
      return controls.topP === undefined ? "omitted" : String(controls.topP);
    default:
      return "declared";
  }
}

function cacheSection(
  ordinal: number,
  section: RequestPlanCacheSectionName,
  parts: readonly string[],
): RequestPlanCacheSection {
  const { sha256, byteLength } = hashParts(parts);
  return Object.freeze({
    ordinal,
    section,
    sha256,
    byteLength,
    estimatedTokens: estimateTokens(byteLength),
    itemCount: parts.length,
  });
}

const warnedSamplingOmissions = new Set<string>();

function warnSamplingFieldNotModifiable(
  provider: string,
  model: string,
  field: string,
): void {
  const key = `${provider}:${model}:${field}`;
  if (warnedSamplingOmissions.has(key)) return;
  warnedSamplingOmissions.add(key);
}

export function compileRequestPlan(input: CompileRequestPlanInput): RequestPlanV1 {
  const messages = Object.freeze([...input.messages]);
  const wire = providerWireApi(input.provider, input.model);
  const target = createReasoningArtifactReplayTarget({
    provider: input.provider,
    model: input.model,
    dialect: REPLAY_DIALECT_BY_WIRE[wire],
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
  });

  const instructionsBoundary = instructionsEnd(messages);
  const liveBoundary = liveStart(messages);
  const sections: RequestPlanBoundary[] = (
    [
      {
        kind: "instructions" as const,
        messageStart: 0,
        messageEnd: instructionsBoundary,
        messageCount: instructionsBoundary,
      },
      {
        kind: "history" as const,
        messageStart: instructionsBoundary,
        messageEnd: liveBoundary,
        messageCount: Math.max(0, liveBoundary - instructionsBoundary),
      },
      {
        kind: "live" as const,
        messageStart: liveBoundary,
        messageEnd: messages.length,
        messageCount: Math.max(0, messages.length - liveBoundary),
      },
    ] as RequestPlanBoundary[]
  ).map((section) => Object.freeze(section));

  const mutableMessageIndexes: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (index >= liveBoundary || isRequestContextSystemMessage(messages[index]!)) {
      mutableMessageIndexes.push(index);
    }
  }

  const reasoningEnabled = Boolean(input.reasoning?.enabled);
  const sampling = resolveSampling({
    provider: input.provider,
    model: input.model,
    reasoningEnabled,
    requestedTemperature: input.temperature,
  });

  const profile = isBuiltInProviderId(input.provider)
    ? resolveBuiltInProfile({
        provider: input.provider,
        model: input.model,
        endpointHash: target.endpointHash,
      })
    : (customProviderProfileFor({
        provider: input.provider,
        model: input.model,
        baseUrl: input.endpoint ?? "",
      }) ??
      resolveProviderProfile({
        provider: input.provider,
        model: input.model,
        wireApi: wire,
        endpointHash: target.endpointHash,
      }));

  const samplingOmit = new Set(profile.sampling.omit ?? []);
  const emittedTemperature = samplingOmit.has("temperature")
    ? undefined
    : sampling.temperature;
  const emittedTopP = samplingOmit.has("top_p") ? undefined : sampling.topP;
  if (input.temperature !== undefined && emittedTemperature === undefined) {
    warnSamplingFieldNotModifiable(input.provider, input.model, "temperature");
  }

  const controlDeclared = profile.reasoning.control.status === "supported";
  const controlSuppression = isReasoningUnsupported(input.provider, input.model)
    ? ("observed-rejection" as const)
    : reasoningEnabled &&
        !controlDeclared &&
        !modelSupportsThinking(input.provider, input.model)
      ? ("capability-denied" as const)
      : undefined;
  const emittedReasoning =
    input.reasoning &&
    profile.reasoning.acceptedEfforts.length > 0 &&
    !profile.reasoning.acceptedEfforts.includes(input.reasoning.effort)
      ? {
          ...input.reasoning,
          effort: clampEffortToRoute(
            input.reasoning.effort,
            profile.reasoning.acceptedEfforts,
          ),
        }
      : input.reasoning;

  const decisions: RequestPlanArtifactDecision[] = [];
  const replayedArtifactParts: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const withinCacheBoundary =
      index < liveBoundary && !isRequestContextSystemMessage(message);
    for (const artifact of reasoningArtifactsForMessage(message)) {
      const decision = reasoningArtifactReplayDecision(artifact, target, {
        hasToolCalls: Boolean(
          message.toolCalls?.length ||
            (typeof message.content === "string" &&
              (/```tool\b|<tool_call>|<\|tool_call/i.test(message.content))),
        ),
      });
      decisions.push(Object.freeze({ messageIndex: index, decision }));
      if (decision.action === "replayed" && withinCacheBoundary) {
        replayedArtifactParts.push(
          JSON.stringify({
            kind: artifact.kind,
            raw: artifact.raw,
            position: artifact.position,
          }),
        );
      }
    }
  }

  const tools = Object.freeze([...(input.tools ?? [])]);
  const imageMessageIndexes: number[] = [];
  let imageCount = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const count = messages[index]!.images?.length ?? 0;
    if (count > 0) {
      imageMessageIndexes.push(index);
      imageCount += count;
    }
  }

  const stableInstructions = messages
    .slice(0, instructionsBoundary)
    .filter((message) => !isRequestContextSystemMessage(message));
  const stableHistory = messages
    .slice(instructionsBoundary, liveBoundary)
    .filter((message) => !isRequestContextSystemMessage(message));
  const settingsValueInput = {
    reasoningEnabled: Boolean(emittedReasoning?.enabled),
    effort: emittedReasoning?.effort ?? "medium",
    temperature: emittedTemperature,
    topP: emittedTopP,
  };

  const cacheSections: RequestPlanCacheSection[] = [
    cacheSection(1, "instructions", stableInstructions.map((m) => JSON.stringify(m))),
    cacheSection(2, "tools", tools.map((tool) => JSON.stringify(tool))),
    cacheSection(3, "history", stableHistory.map((m) => JSON.stringify(m))),
    cacheSection(4, "artifacts", replayedArtifactParts),
    cacheSection(
      5,
      "settings",
      [
        `serializer:${wire}`,
        `version:${REQUEST_PLAN_COMPILER_VERSION}`,
        ...[...profile.cache.cacheAffectingFields]
          .sort()
          .map((field) => `${field}=${cacheAffectingValue(field, settingsValueInput)}`),
      ],
    ),
  ];

  const prefixHash = createHash("sha256").update(PLAN_HASH_DOMAIN, "utf8");
  for (const section of cacheSections) prefixHash.update(section.sha256, "hex");

  const requestedMaxTokens =
    input.maxTokens === undefined
      ? undefined
      : profile.limits.outputTokens === undefined
        ? input.maxTokens
        : Math.min(input.maxTokens, profile.limits.outputTokens);

  return Object.freeze({
    version: REQUEST_PLAN_VERSION,
    route: Object.freeze({
      provider: input.provider,
      model: input.model,
      serializer: wire,
      serializerVersion: 1,
      compilerVersion: REQUEST_PLAN_COMPILER_VERSION,
      ...(target.endpointHash ? { endpointHash: target.endpointHash } : {}),
    }),
    timeline: Object.freeze({
      messages,
      sections: Object.freeze(sections),
      mutableMessageIndexes: Object.freeze(mutableMessageIndexes),
    }),
    tools: Object.freeze({
      definitions: tools,
      ...(input.toolChoice !== undefined ? { choice: input.toolChoice } : {}),
      ...(input.parallelToolCalls !== undefined
        ? { parallelToolCalls: input.parallelToolCalls }
        : {}),
    }),
    replay: Object.freeze({
      target,
      decisions: Object.freeze(decisions),
    }),
    controls: Object.freeze({
      ...(emittedReasoning ? { reasoning: emittedReasoning } : {}),
      ...(controlSuppression ? { controlSuppression } : {}),
      ...(emittedTemperature !== undefined
        ? { temperature: emittedTemperature }
        : {}),
      ...(emittedTopP !== undefined ? { topP: emittedTopP } : {}),
      ...(requestedMaxTokens !== undefined
        ? { requestedMaxTokens }
        : {}),
      stream: input.stream,
    }),
    images: Object.freeze({
      visionAccepted: modelAcceptsImages(input.provider, input.model),
      imageMessageIndexes: Object.freeze(imageMessageIndexes),
      imageCount,
    }),
    policy: Object.freeze({
      reasoningGeneration: profile.reasoning.generation,
      controlDialect: profile.reasoning.control.dialect,
      controlStatus: profile.reasoning.control.status,
      replayScope: profile.reasoning.replayScope,
      cache: profile.cache,
      limits: profile.limits,
      reasoning: profile.reasoning,
      sampling: profile.sampling,
      outputBudget: profile.outputBudget,
      terminal: profile.terminal,
      ...(profile.capabilities.acceptedParameters
        ? { acceptedParameters: profile.capabilities.acceptedParameters }
        : {}),
    }),
    budget: Object.freeze({ plannedAdmissions: 1 as const }),
    cache: Object.freeze({
      policy: profile.cache,
      fingerprint: Object.freeze({
        prefixMessageCount: stableInstructions.length + stableHistory.length,
        replayedArtifactCount: replayedArtifactParts.length,
        sections: Object.freeze(cacheSections),
        prefixSha256: prefixHash.digest("hex"),
      }),
    }),
  });
}
