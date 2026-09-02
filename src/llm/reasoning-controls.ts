import type { ReasoningEffort, ReasoningPreference } from "../types.js";
import type {
  ProviderProfile,
  ReasoningControlDialect,
  ReasoningDisableForm,
} from "./provider-profile.js";

export type ControlPayload = Readonly<Record<string, unknown>>;

export interface ReasoningControlSurface {
  readonly reasoning: ProviderProfile["reasoning"];
  readonly capabilities: {
    readonly acceptedParameters?: readonly string[] | undefined;
  };
}

export const EFFORT_SCALE: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const EFFORT_BUDGET_TOKENS: Readonly<Record<ReasoningEffort, number>> = {
  none: 0,
  minimal: 1_024,
  low: 4_096,
  medium: 8_192,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
};

export function nearestAcceptedEffort(
  requested: ReasoningEffort,
  accepted: readonly string[],
): string | undefined {
  if (accepted.length === 0) return undefined;
  const normalized = accepted.map((value) => value.trim().toLowerCase());
  const requestedIndex = EFFORT_SCALE.indexOf(requested);
  if (requestedIndex < 0) return normalized[0];
  for (let distance = 0; distance < EFFORT_SCALE.length; distance += 1) {
    for (const index of [requestedIndex + distance, requestedIndex - distance]) {
      if (index < 0 || index >= EFFORT_SCALE.length) continue;
      const candidate = EFFORT_SCALE[index]!;
      if (normalized.includes(candidate)) return candidate;
    }
  }
  return normalized[0];
}

function cheapestAcceptedEffort(accepted: readonly string[]): string | undefined {
  return nearestAcceptedEffort("none", accepted);
}

interface ControlIntent {
  readonly enabled: boolean;
  readonly effort: string | undefined;
  readonly budgetTokens: number;
}

const EFFORT_PRIMARY_DIALECTS: ReadonlySet<ReasoningControlDialect> = new Set([
  "openai-effort",
  "openai-nested-reasoning",
  "meta-reasoning-effort",
  "modal-advertised-effort",
]);

function resolveIntent(
  profile: ReasoningControlSurface,
  preference: ReasoningPreference | undefined,
): ControlIntent | undefined {
  const { reasoning } = profile;
  if (reasoning.control.status === "unsupported") return undefined;
  const requested: ReasoningEffort = preference?.effort ?? "medium";
  const wants = Boolean(preference?.enabled) && requested !== "none";
  const mandatory = reasoning.generation === "mandatory";
  if (!wants && !mandatory) {
    return {
      enabled: false,
      effort: disabledEffort(reasoning.disableForm, reasoning.acceptedEfforts),
      budgetTokens: 0,
    };
  }
  const effective: ReasoningEffort = wants
    ? requested
    : ((cheapestAcceptedEffort(reasoning.acceptedEfforts) ??
        "minimal") as ReasoningEffort);
  const mapped =
    nearestAcceptedEffort(effective, reasoning.acceptedEfforts) ??
    reasoning.defaultEffort ??
    (EFFORT_PRIMARY_DIALECTS.has(reasoning.control.dialect)
      ? effective
      : undefined);
  return {
    enabled: true,
    effort: mapped,
    budgetTokens: EFFORT_BUDGET_TOKENS[effective] ?? EFFORT_BUDGET_TOKENS.medium,
  };
}

function disabledEffort(
  disableForm: ReasoningDisableForm | undefined,
  accepted: readonly string[],
): string | undefined {
  switch (disableForm) {
    case "effort-none":
      return "none";
    case "effort-minimal-floor":
      return accepted.includes("minimal")
        ? "minimal"
        : cheapestAcceptedEffort(accepted);
    default:
      return undefined;
  }
}

function templateThinkingField(
  disableForm: ReasoningDisableForm | undefined,
): "thinking" | "enable_thinking" {
  return disableForm === "template-enable-thinking-false"
    ? "enable_thinking"
    : "thinking";
}

function shapeByDialect(
  dialect: ReasoningControlDialect,
  intent: ControlIntent,
  profile: ReasoningControlSurface,
): ControlPayload {
  const { reasoning } = profile;
  const { enabled, effort, budgetTokens } = intent;
  switch (dialect) {
    case "openai-effort":
    case "meta-reasoning-effort":
    case "modal-advertised-effort":
      return effort === undefined ? {} : { reasoning_effort: effort };
    case "openai-nested-reasoning":
      return enabled
        ? { reasoning: { enabled: true, ...(effort ? { effort } : {}) } }
        : { reasoning: { enabled: false } };
    case "openrouter-reasoning-max-tokens":
      return enabled
        ? { reasoning: { enabled: true, max_tokens: budgetTokens } }
        : { reasoning: { enabled: false } };
    case "anthropic-thinking":
      return enabled
        ? { thinking: { type: "enabled", budget_tokens: budgetTokens } }
        : { thinking: { type: "disabled" } };
    case "deepseek-thinking":
      return {
        thinking: { type: enabled ? "enabled" : "disabled" },
        ...(enabled && effort !== undefined ? { reasoning_effort: effort } : {}),
      };
    case "qwen-enable-thinking":
      return enabled
        ? {
            enable_thinking: true,
            ...(effort !== undefined
              ? { reasoning_effort: effort }
              : { thinking_budget: budgetTokens }),
          }
        : {};
    case "kimi-template-thinking":
      return { chat_template_kwargs: { thinking: enabled } };
    case "glm-enable-thinking":
      return {
        chat_template_kwargs: enabled
          ? { enable_thinking: true, clear_thinking: false }
          : { enable_thinking: false },
      };
    case "chat-template-thinking":
      return {
        chat_template_kwargs: {
          [templateThinkingField(reasoning.disableForm)]: enabled,
        },
      };
    case "nemotron-reasoning-budget":
      return enabled
        ? {
            reasoning_budget: budgetTokens,
            chat_template_kwargs: { enable_thinking: true },
          }
        : { chat_template_kwargs: { enable_thinking: false } };
    case "gemini-thinking-config":
      return {
        thinkingConfig: enabled
          ? { includeThoughts: true, thinkingBudget: budgetTokens }
          : { includeThoughts: false, thinkingBudget: 0 },
      };
    case "ollama-think":
      return { think: enabled };
    case "groq-model-specific":
    case "none":
      return {};
  }
}

function replayOptInPayload(
  profile: ReasoningControlSurface,
  willReplayReasoning: boolean,
): ControlPayload {
  if (!willReplayReasoning) return {};
  switch (profile.reasoning.replayOptIn) {
    case "qwen-preserve-thinking":
      return { preserve_thinking: true };
    case "kimi-thinking-keep":
      return { thinking: { keep: "all" } };
    case "openrouter-reasoning-context":
      return { reasoning: { context: "all_turns" } };
    case undefined:
      return {};
  }
}

function mergeControlPayloads(
  base: ControlPayload,
  overlay: ControlPayload,
): ControlPayload {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = merged[key];
    merged[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? { ...existing, ...value }
        : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function filterByAcceptedParameters(
  payload: ControlPayload,
  accepted: readonly string[] | undefined,
): ControlPayload {
  if (!accepted || accepted.length === 0) return payload;
  const allowed = new Set(accepted.map((name) => name.trim().toLowerCase()));
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (allowed.has(key.toLowerCase())) filtered[key] = value;
  }
  return filtered;
}

export function emitReasoningControls(input: {
  readonly profile: ReasoningControlSurface;
  readonly preference: ReasoningPreference | undefined;
  readonly willReplayReasoning: boolean;
}): ControlPayload {
  const { profile, preference, willReplayReasoning } = input;
  const intent = resolveIntent(profile, preference);
  if (!intent) return {};
  const shaped = shapeByDialect(
    profile.reasoning.control.dialect,
    intent,
    profile,
  );
  const withReplay = intent.enabled
    ? mergeControlPayloads(
        shaped,
        replayOptInPayload(profile, willReplayReasoning),
      )
    : shaped;
  return filterByAcceptedParameters(
    withReplay,
    profile.capabilities.acceptedParameters,
  );
}
