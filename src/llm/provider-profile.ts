import { providerIds } from "../types.js";
import type { ProviderId, RequestFingerprintSerializerId } from "../types.js";
import { mergeLayers, unknownProfile } from "./profile/layer-merge.js";
import {
  ControlRejectionKey,
  controlRejections,
  rejectionStoreKey,
} from "./profile/control-rejections.js";
export {
  DEFAULT_CONTROL_REJECTION_TTL_MS,
  activeControlRejections,
  applyObservedControlRejections,
  recordControlRejection,
} from "./profile/control-rejections.js";
export type { ControlRejectionKey } from "./profile/control-rejections.js";

export type ProfileTriState = "supported" | "unsupported" | "unknown";

export type ProfileEvidenceSource =
  "user-config" | "builtin" | "catalog" | "family" | "observed" | "default";

export type ProfileConfidence = "exact" | "high" | "inferred" | "unknown";

export interface ProfileEvidence {
  readonly source: ProfileEvidenceSource;
  readonly confidence: ProfileConfidence;
  readonly observedAt?: string | undefined;
  readonly detail?: string | undefined;
}

export type WireApi = RequestFingerprintSerializerId;

export type SystemMessagePolicy =
  "single-leading" | "developer-fallback" | "provider-system-field";

export type ProfileAuthType =
  | "bearer"
  | "custom-headers"
  | "query"
  | "proxy-headers"
  | "none-keyless"
  | "native";

export interface TransportSpec {
  readonly authType: ProfileAuthType;
  readonly keyEnv?: string | undefined;
  readonly baseUrlEnv?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly chatPath?: string | undefined;
  readonly modelsPath?: string | undefined;
  readonly keyless?: boolean | undefined;
  readonly systemPolicy: SystemMessagePolicy;
}

export interface ProfileCapabilities {
  readonly tools: ProfileTriState;
  readonly images: ProfileTriState;
  readonly structuredOutput: ProfileTriState;
  readonly streamOptions: ProfileTriState;
  readonly acceptedParameters?: readonly string[] | undefined;
}

export interface SamplingPolicySpec {
  readonly omit: readonly string[];
  readonly defaults: Readonly<Record<string, number>>;
}

export type ReasoningGeneration =
  "none" | "optional" | "default-on" | "mandatory" | "unknown";

export type ReasoningControlDialect =
  | "openai-effort"
  | "openai-nested-reasoning"
  | "anthropic-thinking"
  | "deepseek-thinking"
  | "qwen-enable-thinking"
  | "kimi-template-thinking"
  | "glm-enable-thinking"
  | "chat-template-thinking"
  | "nemotron-reasoning-budget"
  | "gemini-thinking-config"
  | "meta-reasoning-effort"
  | "ollama-think"
  | "groq-model-specific"
  | "modal-advertised-effort"
  | "openrouter-reasoning-max-tokens"
  | "none";

export type ReasoningDisableForm =
  | "effort-none"
  | "effort-minimal-floor"
  | "thinking-disabled"
  | "thinking-budget-zero"
  | "template-thinking-false"
  | "template-enable-thinking-false"
  | "enable-thinking-false"
  | "omit-control"
  | "none-documented";

export type ReasoningOutputShape =
  | "reasoning-content"
  | "reasoning-field"
  | "signed-thinking-block"
  | "thought-signature"
  | "encrypted-reasoning-items"
  | "structured-details"
  | "ollama-thinking";

export type FinalTurnPreservation =
  "required" | "supported" | "unsupported" | "unknown";

export interface ReasoningControlSpec {
  readonly dialect: ReasoningControlDialect;
  readonly status: ProfileTriState;
  readonly evidence: ProfileEvidence;
}

export type ProfileReplayScope =
  | "none"
  | "tool-turn"
  | "next-turn"
  | "all-history"
  | "server-state"
  | "configurable";

export type ReplayOptIn =
  | "qwen-preserve-thinking"
  | "kimi-thinking-keep"
  | "openrouter-reasoning-context";

export interface ReasoningCapability {
  readonly generation: ReasoningGeneration;
  readonly generationEvidence: ProfileEvidence;
  readonly control: ReasoningControlSpec;
  readonly acceptedEfforts: readonly string[];
  readonly disable: ProfileTriState;
  readonly disableForm?: ReasoningDisableForm | undefined;
  readonly outputShapes: readonly ReasoningOutputShape[];
  readonly replayScope: ProfileReplayScope;
  readonly finalTurnPreservation: FinalTurnPreservation;
  readonly replayOptIn?: ReplayOptIn | undefined;
  readonly defaultEffort?: string | undefined;
  readonly minOutputTokens?: number | undefined;
}

export interface OutputBudgetPolicy {
  readonly sharedReasoningCap: boolean;
  readonly visibleAnswerReserveTokens: number;
  readonly mandatoryReasoningReserveTokens: number;
}

export type LimitSource =
  "provider-doc" | "catalog" | "user-config" | "family-default" | "unknown";

export interface ContextLimitSpec {
  readonly contextTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly source: LimitSource;
}

export type CachePolicyKind =
  | "automatic-prefix"
  | "affinity-key"
  | "explicit-breakpoint"
  | "none-documented"
  | "unknown";

export interface CachePolicySpec {
  readonly kind: CachePolicyKind;
  readonly affinityField?: string | undefined;
  readonly isolationField?: string | undefined;
  readonly cacheAffectingFields: readonly string[];
  readonly evidence?: ProfileEvidence | undefined;
}

export interface UsageAliasSpec {
  readonly cachedInput?: readonly string[] | undefined;
  readonly uncachedInput?: readonly string[] | undefined;
  readonly cacheWrite?: readonly string[] | undefined;
  readonly reasoningOutput?: readonly string[] | undefined;
}

export type StreamTerminalProof =
  | "done-sentinel"
  | "finish-reason"
  | "message-stop"
  | "response-completed"
  | "response-incomplete"
  | "done-true"
  | "usage-chunk";

export const CHAT_COMPLETIONS_TERMINAL_PROOFS: readonly StreamTerminalProof[] =
  ["done-sentinel", "finish-reason", "usage-chunk"];

export interface TerminalPolicySpec {
  readonly proofs: readonly StreamTerminalProof[];
  readonly naturalEofAccepted: boolean;
  readonly evidence: ProfileEvidence;
}

export interface ProviderProfileRoute {
  readonly provider: string;
  readonly model: string;
  readonly wireApi: WireApi;
  // hashes only; raw endpoints, credentials, and queries never enter a profile
  readonly endpointHash?: string | undefined;
  readonly credentialHash?: string | undefined;
  readonly configGeneration?: string | undefined;
  readonly profileVersion: 1;
}

export interface ProviderProfile {
  readonly version: 1;
  readonly route: ProviderProfileRoute;
  readonly transport: TransportSpec;
  readonly capabilities: ProfileCapabilities;
  readonly reasoning: ReasoningCapability;
  readonly sampling: SamplingPolicySpec;
  readonly outputBudget: OutputBudgetPolicy;
  readonly limits: ContextLimitSpec;
  readonly cache: CachePolicySpec;
  readonly usage: UsageAliasSpec;
  readonly terminal: TerminalPolicySpec;
  readonly evidence: ProfileEvidence;
}

export interface ProviderProfileLayer {
  readonly evidence: ProfileEvidence;
  readonly transport?: Partial<TransportSpec> | undefined;
  readonly capabilities?: Partial<ProfileCapabilities> | undefined;
  readonly reasoning?:
    | (Partial<Omit<ReasoningCapability, "control">> & {
        readonly control?: Partial<ReasoningControlSpec> | undefined;
      })
    | undefined;
  readonly outputBudget?: Partial<OutputBudgetPolicy> | undefined;
  readonly sampling?: Partial<SamplingPolicySpec> | undefined;
  readonly limits?: Partial<ContextLimitSpec> | undefined;
  readonly cache?: Partial<CachePolicySpec> | undefined;
  readonly usage?: Partial<UsageAliasSpec> | undefined;
  readonly terminal?: Partial<TerminalPolicySpec> | undefined;
}

export interface ProviderProfileSourceLayers {
  readonly userConfig?: ProviderProfileLayer | undefined;
  readonly builtin?: ProviderProfileLayer | undefined;
  readonly catalog?: ProviderProfileLayer | undefined;
  readonly modelFamily?: ProviderProfileLayer | undefined;
  readonly family?: ProviderProfileLayer | undefined;
  readonly observed?: ProviderProfileLayer | undefined;
}

const LAYER_PRECEDENCE: readonly (keyof ProviderProfileSourceLayers)[] = [
  "userConfig",
  "builtin",
  "catalog",
  "modelFamily",
  "family",
  "observed",
];

export const PARSED_OUTPUT_SHAPES: readonly ReasoningOutputShape[] = [
  "reasoning-content",
  "reasoning-field",
  "signed-thinking-block",
  "thought-signature",
  "encrypted-reasoning-items",
  "structured-details",
  "ollama-thinking",
];

export const UNKNOWN_EVIDENCE: ProfileEvidence = {
  source: "default",
  confidence: "unknown",
};

export function resolveProviderProfile(input: {
  provider: string;
  model: string;
  wireApi?: WireApi | undefined;
  endpointHash?: string | undefined;
  credentialHash?: string | undefined;
  configGeneration?: string | undefined;
  layers?: ProviderProfileSourceLayers | undefined;
}): ProviderProfile {
  const route: ProviderProfileRoute = {
    provider: input.provider,
    model: input.model,
    wireApi: input.wireApi ?? "chat-completions",
    ...(input.endpointHash ? { endpointHash: input.endpointHash } : {}),
    ...(input.credentialHash ? { credentialHash: input.credentialHash } : {}),
    ...(input.configGeneration
      ? { configGeneration: input.configGeneration }
      : {}),
    profileVersion: 1,
  };
  const sourceLayers = input.layers ?? {};
  const layers = LAYER_PRECEDENCE.map((key) => sourceLayers[key]).filter(
    (layer): layer is ProviderProfileLayer => layer !== undefined,
  );
  if (layers.length === 0) return unknownProfile(route);
  return mergeLayers(route, layers);
}

export type Pickable = string | number | boolean | undefined;

export interface ControlRejectionScope {
  readonly provider: string;
  readonly model: string;
  readonly endpointHash?: string | undefined;
  readonly credentialHash?: string | undefined;
  readonly configGeneration?: string | undefined;
}

export interface StoredControlRejection {
  readonly key: ControlRejectionKey;
  readonly storedKey: string;
  readonly expiresAt: number;
}

export function scopeKey(scope: ControlRejectionScope): string {
  return [
    scope.provider,
    scope.model.trim().toLowerCase(),
    scope.endpointHash ?? "",
    scope.credentialHash ?? "",
    scope.configGeneration ?? "",
  ].join("|");
}

export function isControlRejected(
  key: ControlRejectionKey,
  now?: number | undefined,
): boolean {
  const stored = controlRejections.get(rejectionStoreKey(key));
  if (!stored) return false;
  return (now ?? Date.now()) < stored.expiresAt;
}

export function clearControlRejections(): void {
  controlRejections.clear();
}

export function profileSummary(profile: ProviderProfile): {
  provider: string;
  model: string;
  wireApi: WireApi;
  reasoning: {
    generation: ReasoningGeneration;
    controlDialect: ReasoningControlDialect;
    controlStatus: ProfileTriState;
    disable: ProfileTriState;
    replayScope: ProfileReplayScope;
    finalTurnPreservation: FinalTurnPreservation;
    evidenceSources: readonly ProfileEvidenceSource[];
  };
  capabilities: ProfileCapabilities;
  limits: ContextLimitSpec;
  cache: { kind: CachePolicyKind };
  terminal: {
    proofs: readonly StreamTerminalProof[];
    naturalEofAccepted: boolean;
  };
  evidence: ProfileEvidence;
} {
  return {
    provider: profile.route.provider,
    model: profile.route.model,
    wireApi: profile.route.wireApi,
    reasoning: {
      generation: profile.reasoning.generation,
      controlDialect: profile.reasoning.control.dialect,
      controlStatus: profile.reasoning.control.status,
      disable: profile.reasoning.disable,
      replayScope: profile.reasoning.replayScope,
      finalTurnPreservation: profile.reasoning.finalTurnPreservation,
      evidenceSources: [
        profile.reasoning.generationEvidence.source,
        profile.reasoning.control.evidence.source,
      ],
    },
    capabilities: profile.capabilities,
    limits: profile.limits,
    cache: { kind: profile.cache.kind },
    terminal: {
      proofs: profile.terminal.proofs,
      naturalEofAccepted: profile.terminal.naturalEofAccepted,
    },
    evidence: profile.evidence,
  };
}

export function isBuiltInProviderId(provider: string): provider is ProviderId {
  return (providerIds as readonly string[]).includes(provider);
}
