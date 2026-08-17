import { getConfig, hasExplicitConfigKey } from "../store/config.js";
import { modelContextWindow } from "../llm/token-usage.js";
import type { ProviderId } from "../types.js";
import {
  RESERVED_OUTPUT_TOKENS,
  SAFETY_MARGIN_TOKENS,
} from "./request-accounting.js";

export { RESERVED_OUTPUT_TOKENS, SAFETY_MARGIN_TOKENS };

// One authoritative auto-compaction policy, expressed in total estimated
// request tokens (system blocks, history, tool protocol, schemas and media
// together) rather than in transcript size. Behaviour, status line and
// reliability policy all read this module so they cannot disagree.
export const DEFAULT_AUTO_COMPACT_REQUEST_TOKENS = 180_000;

/** A session-specific model window reserves 30% for output and wire overhead. */
export const CUSTOM_CONTEXT_COMPACTION_RATIO = 0.7;

// Never trigger below this: compaction itself needs room to be useful.
export const MIN_AUTO_COMPACT_REQUEST_TOKENS = 20_000;

export type RequestBudgetSource = "explicit" | "legacy" | "default" | "session";

export interface RequestBudget {
  // User-configured (or default) trigger, before model clamping.
  readonly configured: number;
  // Informational known-window safe threshold; never silently changes policy.
  readonly modelSafe: number;
  // The trigger actually applied: configured default or session override.
  readonly effectiveTrigger: number;
  // Where `configured` came from, for diagnostics and migration notices.
  readonly source: RequestBudgetSource;
  // True when the model window, not the configuration, is the binding limit.
  readonly clampedByModel: boolean;
}

// Resolve the configured trigger. An explicit new-style value wins; a raw
// persisted legacy value is honoured exactly once (even 72k) so upgrading does
// not silently change a user's tuning; otherwise the 80k policy applies.
export function configuredRequestTokens(): {
  tokens: number;
  source: RequestBudgetSource;
} {
  const config = getConfig();
  if (
    hasExplicitConfigKey("autoCompactRequestTokens") &&
    typeof config.autoCompactRequestTokens === "number"
  ) {
    return { tokens: config.autoCompactRequestTokens, source: "explicit" };
  }
  if (
    hasExplicitConfigKey("softCompactTokenBudget") &&
    typeof config.softCompactTokenBudget === "number"
  ) {
    return { tokens: config.softCompactTokenBudget, source: "legacy" };
  }
  return {
    tokens: DEFAULT_AUTO_COMPACT_REQUEST_TOKENS,
    source: "default",
  };
}

// Largest request this provider/model can accept with room for the answer.
export function modelSafeRequestTokens(
  provider: ProviderId | undefined,
  model: string | undefined,
): number {
  const window = modelContextWindow(model, provider);
  return Math.max(
    MIN_AUTO_COMPACT_REQUEST_TOKENS,
    window - RESERVED_OUTPUT_TOKENS - SAFETY_MARGIN_TOKENS,
  );
}

export function resolveRequestBudget(input?: {
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly overrideTokens?: number | undefined;
  /** User-declared provider/model window for this session only. */
  readonly contextLimitTokens?: number | undefined;
}): RequestBudget {
  const customLimit = input?.contextLimitTokens;
  if (
    typeof customLimit === "number" &&
    Number.isFinite(customLimit) &&
    customLimit >= MIN_AUTO_COMPACT_REQUEST_TOKENS
  ) {
    const modelSafe = Math.floor(customLimit);
    const effectiveTrigger = Math.floor(modelSafe * CUSTOM_CONTEXT_COMPACTION_RATIO);
    return {
      configured: effectiveTrigger,
      modelSafe,
      effectiveTrigger,
      source: "session",
      clampedByModel: false,
    };
  }
  const resolved = configuredRequestTokens();
  const raw = input?.overrideTokens ?? resolved.tokens;
  const configured = Math.max(MIN_AUTO_COMPACT_REQUEST_TOKENS, raw);
  const modelSafe = modelSafeRequestTokens(input?.provider, input?.model);
  return {
    configured,
    modelSafe,
    effectiveTrigger: configured,
    source: input?.overrideTokens === undefined ? resolved.source : "explicit",
    // The explicit 180k default is provider/model-neutral. A user can opt into
    // a different window through the session control, which always uses 70%.
    clampedByModel: false,
  };
}

// Request budget used by callers that need the active compaction trigger.
export function requestBudgetDenominator(
  provider: ProviderId | undefined,
  model: string | undefined,
  contextLimitTokens?: number | undefined,
): number {
  return resolveRequestBudget({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(contextLimitTokens ? { contextLimitTokens } : {}),
  }).effectiveTrigger;
}
