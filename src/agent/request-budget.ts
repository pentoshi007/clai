import { getConfig, hasExplicitConfigKey } from "../store/config.js";
import { modelContextWindow } from "../llm/token-usage.js";
import type { ProviderId } from "../types.js";
import {
  RESERVED_OUTPUT_TOKENS,
  SAFETY_MARGIN_TOKENS,
} from "./request-accounting.js";

export { RESERVED_OUTPUT_TOKENS, SAFETY_MARGIN_TOKENS };

export const DEFAULT_AUTO_COMPACT_REQUEST_TOKENS = 180_000;

export const CUSTOM_CONTEXT_COMPACTION_RATIO = 0.7;

export const MIN_AUTO_COMPACT_REQUEST_TOKENS = 20_000;

export type RequestBudgetSource = "explicit" | "legacy" | "default" | "session";

export interface RequestBudget {
  readonly configured: number;
  readonly modelSafe: number;
  readonly effectiveTrigger: number;
  readonly source: RequestBudgetSource;
  readonly clampedByModel: boolean;
}

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
    clampedByModel: false,
  };
}

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
