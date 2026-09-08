import { getConfig, hasExplicitConfigKey } from "../store/config.js";
import { modelContextWindow } from "../llm/token-usage.js";
import type { ProviderId } from "../types.js";
import {
  RESERVED_OUTPUT_TOKENS,
  SAFETY_MARGIN_TOKENS,
} from "./request-accounting.js";
import {
  COMPACTION_INPUT_SAFETY_TOKENS,
  COMPACTION_MAX_COMPLETION_TOKENS,
} from "./compaction-summary.js";

export { RESERVED_OUTPUT_TOKENS, SAFETY_MARGIN_TOKENS };

export const DEFAULT_AUTO_COMPACT_REQUEST_TOKENS = 180_000;

export const AUTO_COMPACT_HEADROOM_TOKENS =
  COMPACTION_MAX_COMPLETION_TOKENS + COMPACTION_INPUT_SAFETY_TOKENS;

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

export function effectiveSafeTokensForWindow(window: number): number {
  const floored = Math.max(0, Math.floor(window));
  const reserved = Math.min(
    RESERVED_OUTPUT_TOKENS,
    Math.floor(floored * 0.25),
  );
  return Math.max(1, floored - reserved - SAFETY_MARGIN_TOKENS);
}

export function autoCompactHeadroomTokens(modelSafe: number): number {
  return Math.min(
    AUTO_COMPACT_HEADROOM_TOKENS,
    Math.max(0, Math.floor(modelSafe * 0.25)),
  );
}

function effectiveAutoCompactTrigger(
  configured: number,
  modelSafe: number,
): number {
  return Math.max(
    1,
    Math.min(
      configured,
      modelSafe - autoCompactHeadroomTokens(modelSafe),
    ),
  );
}

export function modelSafeRequestTokens(
  provider: ProviderId | undefined,
  model: string | undefined,
): number {
  return effectiveSafeTokensForWindow(modelContextWindow(model, provider));
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
    const modelSafe = effectiveSafeTokensForWindow(customLimit);
    const configured = Math.floor(customLimit * CUSTOM_CONTEXT_COMPACTION_RATIO);
    const effectiveTrigger = effectiveAutoCompactTrigger(configured, modelSafe);
    return {
      configured,
      modelSafe,
      effectiveTrigger,
      source: "session",
      clampedByModel: effectiveTrigger < configured,
    };
  }
  const resolved = configuredRequestTokens();
  const raw = input?.overrideTokens ?? resolved.tokens;
  const configured = Math.max(MIN_AUTO_COMPACT_REQUEST_TOKENS, raw);
  const modelSafe = modelSafeRequestTokens(input?.provider, input?.model);
  const effectiveTrigger = effectiveAutoCompactTrigger(configured, modelSafe);
  return {
    configured,
    modelSafe,
    effectiveTrigger,
    source: input?.overrideTokens === undefined ? resolved.source : "explicit",
    clampedByModel: effectiveTrigger < configured,
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
