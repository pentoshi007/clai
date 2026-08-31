import { scopeKey } from "../provider-profile.js";
import type {
  ControlRejectionScope,
  ProviderProfile,
  ReasoningControlDialect,
  StoredControlRejection,
} from "../provider-profile.js";

export const DEFAULT_CONTROL_REJECTION_TTL_MS = 15 * 60 * 1000;

export interface ControlRejectionKey extends ControlRejectionScope {
  readonly field: string;
  readonly value?: string | undefined;
}

export const controlRejections = new Map<string, StoredControlRejection>();

export function rejectionStoreKey(key: ControlRejectionKey): string {
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

export function activeControlRejections(
  scope: ControlRejectionScope,
  now?: number | undefined,
): readonly ControlRejectionKey[] {
  const prefix = `${scopeKey(scope)}|`;
  const at = now ?? Date.now();
  return [...controlRejections.values()]
    .filter(
      (stored) => stored.storedKey.startsWith(prefix) && at < stored.expiresAt,
    )
    .map((stored) => stored.key);
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
  "openrouter-reasoning-max-tokens": "reasoning",
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
