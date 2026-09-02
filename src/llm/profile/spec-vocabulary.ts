import type { CustomAuthType } from "../custom-provider-profile.js";
import type {
  CachePolicyKind,
  FinalTurnPreservation,
  LimitSource,
  ProfileReplayScope,
  ProfileTriState,
  ReasoningControlDialect,
  ReasoningDisableForm,
  ReasoningGeneration,
  ReasoningOutputShape,
} from "../provider-profile.js";

export const ALLOWED_KEYS = [
  "authType",
  "keyEnv",
  "baseUrlEnv",
  "headers",
  "tools",
  "images",
  "structuredOutput",
  "streamOptions",
  "reasoning",
  "limits",
  "cache",
  "usage",
  "terminal",
] as const;

export const ALLOWED_REASONING_KEYS = [
  "generation",
  "controlDialect",
  "acceptedEfforts",
  "disable",
  "disableForm",
  "outputShapes",
  "replayScope",
  "finalTurnPreservation",
] as const;

export const ALLOWED_LIMIT_KEYS = [
  "contextTokens",
  "outputTokens",
  "source",
] as const;

export const ALLOWED_CACHE_KEYS = [
  "kind",
  "affinityField",
  "isolationField",
  "cacheAffectingFields",
] as const;

export const ALLOWED_USAGE_KEYS = [
  "cachedInput",
  "uncachedInput",
  "cacheWrite",
  "reasoningOutput",
] as const;

export const ALLOWED_TERMINAL_KEYS = ["naturalEofAccepted"] as const;

export const AUTH_TYPES: readonly CustomAuthType[] = [
  "bearer",
  "custom-headers",
  "none-keyless",
];

export const TRI_STATES: readonly ProfileTriState[] = [
  "supported",
  "unsupported",
  "unknown",
];

export const GENERATIONS: readonly ReasoningGeneration[] = [
  "none",
  "optional",
  "default-on",
  "mandatory",
  "unknown",
];

export const CONTROL_DIALECTS: readonly ReasoningControlDialect[] = [
  "openai-effort",
  "openai-nested-reasoning",
  "anthropic-thinking",
  "deepseek-thinking",
  "qwen-enable-thinking",
  "kimi-template-thinking",
  "glm-enable-thinking",
  "chat-template-thinking",
  "nemotron-reasoning-budget",
  "gemini-thinking-config",
  "meta-reasoning-effort",
  "ollama-think",
  "groq-model-specific",
  "modal-advertised-effort",
  "openrouter-reasoning-max-tokens",
  "none",
];

export const OUTPUT_SHAPES: readonly ReasoningOutputShape[] = [
  "reasoning-content",
  "reasoning-field",
  "signed-thinking-block",
  "thought-signature",
  "encrypted-reasoning-items",
  "structured-details",
  "ollama-thinking",
];

export const REPLAY_SCOPES: readonly ProfileReplayScope[] = [
  "none",
  "tool-turn",
  "next-turn",
  "all-history",
  "server-state",
  "configurable",
];

export const PRESERVATIONS: readonly FinalTurnPreservation[] = [
  "required",
  "supported",
  "unsupported",
  "unknown",
];

export const CACHE_KINDS: readonly CachePolicyKind[] = [
  "automatic-prefix",
  "affinity-key",
  "explicit-breakpoint",
  "none-documented",
  "unknown",
];

export const LIMIT_SOURCES: readonly LimitSource[] = [
  "provider-doc",
  "catalog",
  "user-config",
  "family-default",
  "unknown",
];

export const EFFORT_DIALECT_DISABLE_FORMS: readonly ReasoningDisableForm[] = [
  "effort-none",
  "effort-minimal-floor",
  "omit-control",
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === "string" && allowed.includes(value as T)
    ? (value as T)
    : undefined;
}

export function stringList(
  value: unknown,
  errors: string[],
  field: string,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) {
      errors.push(`${field} entries must be non-empty strings`);
      return undefined;
    }
    list.push(entry.trim());
  }
  return list;
}
