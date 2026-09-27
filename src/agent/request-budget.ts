import {
  resolveContextWindow,
  type ContextWindowSource,
} from "../llm/context-windows.js";
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

export const AUTO_COMPACT_HEADROOM_TOKENS =
  COMPACTION_MAX_COMPLETION_TOKENS + COMPACTION_INPUT_SAFETY_TOKENS;

export const AUTO_COMPACT_CONTEXT_RATIO = 0.7;

export interface RequestBudgetTarget {
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly contextLimitTokens?: number | undefined;
}

export interface RequestBudget {
  readonly windowTokens: number;
  readonly windowSource: ContextWindowSource;
  readonly configured: number;
  readonly modelSafe: number;
  readonly effectiveTrigger: number;
  readonly clampedByModel: boolean;
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

export function resolveRequestBudget(
  target: RequestBudgetTarget = {},
): RequestBudget {
  const window = resolveContextWindow({
    provider: target.provider,
    model: target.model,
    contextLimitTokens: target.contextLimitTokens,
  });
  const configured = Math.floor(window.tokens * AUTO_COMPACT_CONTEXT_RATIO);
  const modelSafe = effectiveSafeTokensForWindow(window.tokens);
  const effectiveTrigger = effectiveAutoCompactTrigger(configured, modelSafe);
  return {
    windowTokens: window.tokens,
    windowSource: window.source,
    configured,
    modelSafe,
    effectiveTrigger,
    clampedByModel: effectiveTrigger < configured,
  };
}

export function autoCompactTriggerTokens(target: RequestBudgetTarget = {}): number {
  return resolveRequestBudget(target).effectiveTrigger;
}
