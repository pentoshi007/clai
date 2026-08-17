import { providerIds } from "../types.js";
import type {
  ProviderId,
  RequestFingerprintSerializerId,
} from "../types.js";

export type ProfileTriState = "supported" | "unsupported" | "unknown";

export type ProfileEvidenceSource =
  | "user-config"
  | "builtin"
  | "catalog"
  | "family"
  | "observed"
  | "default";

export type ProfileConfidence = "exact" | "high" | "inferred" | "unknown";

export interface ProfileEvidence {
  readonly source: ProfileEvidenceSource;
  readonly confidence: ProfileConfidence;
  readonly observedAt?: string | undefined;
  readonly detail?: string | undefined;
}

export type WireApi = RequestFingerprintSerializerId;

export type SystemMessagePolicy =
  | "single-leading"
  | "developer-fallback"
  | "provider-system-field";

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
}

/** Matrix 02§Required conceptual split: the generation fact is independent of controls. */
export type ReasoningGeneration =
  | "none"
  | "optional"
  | "default-on"
  | "mandatory"
  | "unknown";

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
  | "required"
  | "supported"
  | "unsupported"
  | "unknown";

export interface ReasoningControlSpec {
  readonly dialect: ReasoningControlDialect;
  readonly status: ProfileTriState;
  readonly evidence: ProfileEvidence;
}

/** Route-level replay contract; the first four map onto artifact replay scope. */
export type ProfileReplayScope =
  | "none"
  | "tool-turn"
  | "next-turn"
  | "all-history"
  | "server-state"
  | "configurable";

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
}

export interface OutputBudgetPolicy {
  readonly sharedReasoningCap: boolean;
  readonly visibleAnswerReserveTokens: number;
  readonly mandatoryReasoningReserveTokens: number;
}

export type LimitSource =
  | "provider-doc"
  | "catalog"
  | "user-config"
  | "family-default"
  | "unknown";

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
  readonly limits?: Partial<ContextLimitSpec> | undefined;
  readonly cache?: Partial<CachePolicySpec> | undefined;
  readonly usage?: Partial<UsageAliasSpec> | undefined;
  readonly terminal?: Partial<TerminalPolicySpec> | undefined;
}

export interface ProviderProfileSourceLayers {
  readonly userConfig?: ProviderProfileLayer | undefined;
  readonly builtin?: ProviderProfileLayer | undefined;
  readonly catalog?: ProviderProfileLayer | undefined;
  readonly family?: ProviderProfileLayer | undefined;
  readonly observed?: ProviderProfileLayer | undefined;
}

const LAYER_PRECEDENCE: readonly (keyof ProviderProfileSourceLayers)[] = [
  "userConfig",
  "builtin",
  "catalog",
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

export const DEFAULT_CONTROL_REJECTION_TTL_MS = 15 * 60 * 1000;

const UNKNOWN_EVIDENCE: ProfileEvidence = {
  source: "default",
  confidence: "unknown",
};

function unknownProfile(
  route: ProviderProfileRoute,
): ProviderProfile {
  return {
    version: 1,
    route,
    transport: { authType: "bearer", systemPolicy: "single-leading" },
    capabilities: {
      tools: "unknown",
      images: "unknown",
      structuredOutput: "unknown",
      streamOptions: "unknown",
    },
    reasoning: {
      generation: "unknown",
      generationEvidence: UNKNOWN_EVIDENCE,
      control: {
        dialect: "none",
        status: "unknown",
        evidence: UNKNOWN_EVIDENCE,
      },
      acceptedEfforts: [],
      disable: "unknown",
      // unknown routes parse broadly while sending no optional control
      outputShapes: PARSED_OUTPUT_SHAPES,
      replayScope: "none",
      finalTurnPreservation: "unknown",
    },
    outputBudget: {
      sharedReasoningCap: true,
      visibleAnswerReserveTokens: 1024,
      mandatoryReasoningReserveTokens: 0,
    },
    limits: { source: "unknown" },
    cache: { kind: "unknown", cacheAffectingFields: [] },
    usage: {},
    terminal: {
      proofs: [],
      naturalEofAccepted: false,
      evidence: UNKNOWN_EVIDENCE,
    },
    evidence: UNKNOWN_EVIDENCE,
  };
}

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

type Pickable = string | number | boolean | undefined;

function firstDefined<T extends Pickable>(
  layers: readonly ProviderProfileLayer[],
  pick: (layer: ProviderProfileLayer) => T | undefined,
): T | undefined {
  for (const layer of layers) {
    const value = pick(layer);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstList<T>(
  layers: readonly ProviderProfileLayer[],
  pick: (layer: ProviderProfileLayer) => readonly T[] | undefined,
): readonly T[] | undefined {
  for (const layer of layers) {
    const value = pick(layer);
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
}

function evidenceFor(
  layers: readonly ProviderProfileLayer[],
  contributes: (layer: ProviderProfileLayer) => boolean,
): ProfileEvidence {
  for (const layer of layers) {
    if (contributes(layer)) return layer.evidence;
  }
  return UNKNOWN_EVIDENCE;
}

function mergeLayers(
  route: ProviderProfileRoute,
  layers: readonly ProviderProfileLayer[],
): ProviderProfile {
  const base = unknownProfile(route);

  const keyEnv = firstDefined(layers, (l) => l.transport?.keyEnv);
  const baseUrlEnv = firstDefined(layers, (l) => l.transport?.baseUrlEnv);
  const chatPath = firstDefined(layers, (l) => l.transport?.chatPath);
  const modelsPath = firstDefined(layers, (l) => l.transport?.modelsPath);
  const keyless = firstDefined(layers, (l) => l.transport?.keyless);
  const headerLayer = layers.find((layer) => layer.transport?.headers);

  const contextTokens = firstDefined(layers, (l) => l.limits?.contextTokens);
  const outputTokens = firstDefined(layers, (l) => l.limits?.outputTokens);

  const affinityField = firstDefined(layers, (l) => l.cache?.affinityField);
  const isolationField = firstDefined(layers, (l) => l.cache?.isolationField);

  const cachedInput = firstList(layers, (l) => l.usage?.cachedInput);
  const uncachedInput = firstList(layers, (l) => l.usage?.uncachedInput);
  const cacheWrite = firstList(layers, (l) => l.usage?.cacheWrite);
  const reasoningOutput = firstList(layers, (l) => l.usage?.reasoningOutput);

  const controlDialect = firstDefined(
    layers,
    (l) => l.reasoning?.control?.dialect,
  );
  const controlStatus = firstDefined(
    layers,
    (l) => l.reasoning?.control?.status,
  );
  const generation =
    firstDefined(layers, (l) => l.reasoning?.generation) ?? "unknown";
  const disableForm = firstDefined(layers, (l) => l.reasoning?.disableForm);
  const disable =
    firstDefined(layers, (l) => l.reasoning?.disable) ??
    (generation === "mandatory" ? "unsupported" : "unknown");

  return {
    version: 1,
    route,
    transport: {
      authType:
        firstDefined(layers, (l) => l.transport?.authType) ??
        base.transport.authType,
      ...(keyEnv !== undefined ? { keyEnv } : {}),
      ...(baseUrlEnv !== undefined ? { baseUrlEnv } : {}),
      ...(chatPath !== undefined ? { chatPath } : {}),
      ...(modelsPath !== undefined ? { modelsPath } : {}),
      ...(keyless !== undefined ? { keyless } : {}),
      ...(headerLayer ? { headers: headerLayer.transport!.headers! } : {}),
      systemPolicy:
        firstDefined(layers, (l) => l.transport?.systemPolicy) ??
        base.transport.systemPolicy,
    },
    capabilities: {
      tools:
        firstDefined(layers, (l) => l.capabilities?.tools) ??
        base.capabilities.tools,
      images:
        firstDefined(layers, (l) => l.capabilities?.images) ??
        base.capabilities.images,
      structuredOutput:
        firstDefined(layers, (l) => l.capabilities?.structuredOutput) ??
        base.capabilities.structuredOutput,
      streamOptions:
        firstDefined(layers, (l) => l.capabilities?.streamOptions) ??
        base.capabilities.streamOptions,
    },
    reasoning: {
      generation,
      generationEvidence: evidenceFor(
        layers,
        (l) => l.reasoning?.generation !== undefined,
      ),
      control: {
        dialect: controlDialect ?? base.reasoning.control.dialect,
        status: controlStatus ?? base.reasoning.control.status,
        evidence: evidenceFor(
          layers,
          (l) => l.reasoning?.control !== undefined,
        ),
      },
      acceptedEfforts:
        firstList(layers, (l) => l.reasoning?.acceptedEfforts) ?? [],
      disable,
      ...(disableForm !== undefined
        ? { disableForm }
        : generation === "mandatory"
          ? { disableForm: "none-documented" as const }
          : {}),
      outputShapes:
        firstList(layers, (l) => l.reasoning?.outputShapes) ??
        base.reasoning.outputShapes,
      replayScope:
        firstDefined(layers, (l) => l.reasoning?.replayScope) ??
        base.reasoning.replayScope,
      finalTurnPreservation:
        firstDefined(layers, (l) => l.reasoning?.finalTurnPreservation) ??
        base.reasoning.finalTurnPreservation,
    },
    outputBudget: {
      sharedReasoningCap:
        firstDefined(layers, (l) => l.outputBudget?.sharedReasoningCap) ??
        base.outputBudget.sharedReasoningCap,
      visibleAnswerReserveTokens:
        firstDefined(
          layers,
          (l) => l.outputBudget?.visibleAnswerReserveTokens,
        ) ?? base.outputBudget.visibleAnswerReserveTokens,
      mandatoryReasoningReserveTokens:
        firstDefined(
          layers,
          (l) => l.outputBudget?.mandatoryReasoningReserveTokens,
        ) ?? base.outputBudget.mandatoryReasoningReserveTokens,
    },
    limits: {
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      source:
        firstDefined(layers, (l) => l.limits?.source) ?? base.limits.source,
    },
    cache: {
      kind: firstDefined(layers, (l) => l.cache?.kind) ?? base.cache.kind,
      ...(affinityField !== undefined ? { affinityField } : {}),
      ...(isolationField !== undefined ? { isolationField } : {}),
      cacheAffectingFields:
        firstList(layers, (l) => l.cache?.cacheAffectingFields) ??
        base.cache.cacheAffectingFields,
      evidence: evidenceFor(layers, (l) => l.cache?.kind !== undefined),
    },
    usage: {
      ...(cachedInput !== undefined ? { cachedInput } : {}),
      ...(uncachedInput !== undefined ? { uncachedInput } : {}),
      ...(cacheWrite !== undefined ? { cacheWrite } : {}),
      ...(reasoningOutput !== undefined ? { reasoningOutput } : {}),
    },
    terminal: {
      proofs:
        firstList(layers, (l) => l.terminal?.proofs) ?? base.terminal.proofs,
      naturalEofAccepted:
        firstDefined(layers, (l) => l.terminal?.naturalEofAccepted) ??
        base.terminal.naturalEofAccepted,
      evidence: evidenceFor(layers, (l) => l.terminal?.proofs !== undefined),
    },
    evidence: layers[0]!.evidence,
  };
}

export interface ControlRejectionScope {
  readonly provider: string;
  readonly model: string;
  readonly endpointHash?: string | undefined;
  readonly credentialHash?: string | undefined;
  readonly configGeneration?: string | undefined;
}

export interface ControlRejectionKey extends ControlRejectionScope {
  readonly field: string;
  readonly value?: string | undefined;
}

interface StoredControlRejection {
  readonly key: ControlRejectionKey;
  readonly storedKey: string;
  readonly expiresAt: number;
}

const controlRejections = new Map<string, StoredControlRejection>();

function scopeKey(scope: ControlRejectionScope): string {
  return [
    scope.provider,
    scope.model.trim().toLowerCase(),
    scope.endpointHash ?? "",
    scope.credentialHash ?? "",
    scope.configGeneration ?? "",
  ].join("|");
}

function rejectionStoreKey(key: ControlRejectionKey): string {
  return `${scopeKey(key)}|${key.field.trim().toLowerCase()}|${
    key.value?.trim().toLowerCase() ?? ""
  }`;
}

export function recordControlRejection(
  key: ControlRejectionKey,
  options?: { ttlMs?: number; now?: number } | undefined,
): void {
  if (!key.field.trim()) return;
  const now = options?.now ?? Date.now();
  const ttl =
    options?.ttlMs === undefined
      ? DEFAULT_CONTROL_REJECTION_TTL_MS
      : Math.max(0, options.ttlMs);
  const storedKey = rejectionStoreKey(key);
  controlRejections.set(storedKey, {
    key: { ...key, field: key.field.trim() },
    storedKey,
    expiresAt: now + ttl,
  });
}

export function isControlRejected(
  key: ControlRejectionKey,
  now?: number | undefined,
): boolean {
  const stored = controlRejections.get(rejectionStoreKey(key));
  if (!stored) return false;
  return (now ?? Date.now()) < stored.expiresAt;
}

export function activeControlRejections(
  scope: ControlRejectionScope,
  now?: number | undefined,
): readonly ControlRejectionKey[] {
  const prefix = `${scopeKey(scope)}|`;
  const at = now ?? Date.now();
  return [...controlRejections.values()]
    .filter(
      (stored) =>
        stored.storedKey.startsWith(prefix) && at < stored.expiresAt,
    )
    .map((stored) => stored.key);
}

export function clearControlRejections(): void {
  controlRejections.clear();
}

const CONTROL_FIELD_BY_DIALECT: Record<ReasoningControlDialect, string> = {
  "openai-effort": "reasoning_effort",
  "openai-nested-reasoning": "reasoning",
  "anthropic-thinking": "reasoning_effort",
  "deepseek-thinking": "thinking",
  "qwen-enable-thinking": "enable_thinking",
  "kimi-template-thinking": "chat_template_kwargs",
  "glm-enable-thinking": "chat_template_kwargs",
  "chat-template-thinking": "chat_template_kwargs",
  "nemotron-reasoning-budget": "reasoning_budget",
  "gemini-thinking-config": "generationconfig.thinkingconfig",
  "meta-reasoning-effort": "reasoning_effort",
  "ollama-think": "think",
  "groq-model-specific": "reasoning_effort",
  "modal-advertised-effort": "reasoning_effort",
  none: "",
};

const REASONING_CONTROL_FIELDS = new Set(
  Object.values(CONTROL_FIELD_BY_DIALECT).filter(Boolean),
);

// a rejected control downgrades only the control facet; parsing stays permissive
export function applyObservedControlRejections(
  profile: ProviderProfile,
  now?: number | undefined,
): ProviderProfile {
  const dialect = profile.reasoning.control.dialect;
  const dialectField = CONTROL_FIELD_BY_DIALECT[dialect];
  const matchesRoute = (field: string) =>
    dialectField !== ""
      ? field === dialectField
      : REASONING_CONTROL_FIELDS.has(field);
  const rejection = activeControlRejections(profile.route, now).find(
    (candidate) => matchesRoute(candidate.field.toLowerCase()),
  );
  if (!rejection) return profile;
  return {
    ...profile,
    reasoning: {
      ...profile.reasoning,
      control: {
        ...profile.reasoning.control,
        status: "unsupported",
        evidence: {
          source: "observed",
          confidence: "inferred",
          observedAt: new Date(now ?? Date.now()).toISOString(),
          detail: rejection.value
            ? `rejected ${rejection.field}=${rejection.value}`
            : `rejected ${rejection.field}`,
        },
      },
    },
  };
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
