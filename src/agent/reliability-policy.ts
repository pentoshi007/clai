
import { createHash } from "node:crypto";
import { getConfig, providerCategory } from "../store/config.js";
import type { ProviderId } from "../types.js";
import { AUTO_COMPACT_TOKEN_BUDGET } from "./context-manager.js";
import {
  DEFAULT_AUTO_COMPACT_REQUEST_TOKENS,
  MIN_AUTO_COMPACT_REQUEST_TOKENS,
  configuredRequestTokens,
  resolveRequestBudget,
} from "./request-budget.js";

export const HARD_COMPACT_TOKEN_BUDGET = AUTO_COMPACT_TOKEN_BUDGET;

export const DEFAULT_SOFT_COMPACT_TOKEN_BUDGET =
  DEFAULT_AUTO_COMPACT_REQUEST_TOKENS;

export const DEFAULT_FS_PASSTHROUGH_CAP_CHARS = 64_000;

export const DEFAULT_FREE_TIER_FAIL_THRESHOLD = 2;

export const ADAPTIVE_MAX_TOKENS_TOOL_STEP = 24_576;
export const ADAPTIVE_MAX_TOKENS_LIGHT = 12_288;
export const ADAPTIVE_MAX_TOKENS_FLOOR = 8_192;
export const LEGACY_MAX_TOKENS = 32_768;
export const MAX_STEP_COMPLETION_TOKENS = 65_536;
export const MAX_OUTPUT_BUDGET_CONTINUATIONS = 1;

export interface ReliabilityPolicy {
  readonly softEarlyCompact: boolean;
  readonly softCompactTokenBudget: number;
  readonly hardCompactTokenBudget: number;
  readonly fsPassthroughCapChars: number;
  readonly adaptiveMaxTokens: boolean;
  readonly freeTierContextGuard: boolean;
  readonly freeTierFailThreshold: number;
  readonly toolResultDedup: boolean;
  readonly slimNativePrompt: boolean;
}

function boolEnv(name: string): boolean | undefined {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return undefined;
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

function intEnv(name: string): number | undefined {
  const v = process.env[name]?.trim();
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function getReliabilityPolicy(): ReliabilityPolicy {
  const cfg = getConfig();
  const softEarly =
    boolEnv("CLAI_SOFT_EARLY_COMPACT") ?? cfg.softEarlyCompact ?? true;
  let softBudget =
    intEnv("CLAI_SOFT_COMPACT_TOKENS") ?? configuredRequestTokens().tokens;
  softBudget = Math.max(
    MIN_AUTO_COMPACT_REQUEST_TOKENS,
    Math.min(softBudget, HARD_COMPACT_TOKEN_BUDGET),
  );

  let fsCap =
    intEnv("CLAI_FS_PASSTHROUGH_CHARS") ??
    cfg.fsPassthroughCapChars ??
    DEFAULT_FS_PASSTHROUGH_CAP_CHARS;
  fsCap = Math.max(8_000, Math.min(fsCap, 400_000));

  return {
    softEarlyCompact: softEarly,
    softCompactTokenBudget: softBudget,
    hardCompactTokenBudget: HARD_COMPACT_TOKEN_BUDGET,
    fsPassthroughCapChars: fsCap,
    adaptiveMaxTokens:
      boolEnv("CLAI_ADAPTIVE_MAX_TOKENS") ?? cfg.adaptiveMaxTokens ?? true,
    freeTierContextGuard:
      boolEnv("CLAI_FREE_TIER_GUARD") ?? cfg.freeTierContextGuard ?? true,
    freeTierFailThreshold:
      intEnv("CLAI_FREE_TIER_FAIL_THRESHOLD") ??
      cfg.freeTierFailThreshold ??
      DEFAULT_FREE_TIER_FAIL_THRESHOLD,
    toolResultDedup:
      boolEnv("CLAI_TOOL_RESULT_DEDUP") ?? cfg.toolResultDedup ?? true,
    slimNativePrompt:
      boolEnv("CLAI_SLIM_NATIVE_PROMPT") ?? cfg.slimNativePrompt ?? true,
  };
}

export function autoCompactTriggerTokens(
  policy = getReliabilityPolicy(),
  target?: {
    provider?: ProviderId | undefined;
    model?: string | undefined;
    contextLimitTokens?: number | undefined;
  },
): number {
  const configured = policy.softEarlyCompact
    ? Math.min(policy.softCompactTokenBudget, policy.hardCompactTokenBudget)
    : policy.hardCompactTokenBudget;
  return resolveRequestBudget({
    ...(target?.provider ? { provider: target.provider } : {}),
    ...(target?.model ? { model: target.model } : {}),
    ...(target?.contextLimitTokens
      ? { contextLimitTokens: target.contextLimitTokens }
      : {}),
    overrideTokens: configured,
  }).effectiveTrigger;
}

export function resolveStepMaxTokens(input: {
  nativeToolsActive: boolean;
  toolsAttached: boolean;
  recoveryNudge?: boolean | undefined;
  truncationDepth?: number | undefined;
  thinkingEnabled?: boolean | undefined;
  minimumTokens?: number | undefined;
  outputTokenLimit?: number | undefined;
  policy?: ReliabilityPolicy | undefined;
}): number {
  const policy = input.policy ?? getReliabilityPolicy();
  const base = (() => {
    if (!policy.adaptiveMaxTokens) return LEGACY_MAX_TOKENS;
    if (input.recoveryNudge) {
      return Math.max(ADAPTIVE_MAX_TOKENS_FLOOR, ADAPTIVE_MAX_TOKENS_LIGHT);
    }
    const adaptive =
      input.toolsAttached || input.nativeToolsActive
        ? ADAPTIVE_MAX_TOKENS_TOOL_STEP
        : ADAPTIVE_MAX_TOKENS_LIGHT;
    if (input.thinkingEnabled) {
      return Math.max(adaptive, LEGACY_MAX_TOKENS);
    }
    return adaptive;
  })();
  const depth = input.truncationDepth ?? 0;
  const expanded =
    depth > 0
      ? Math.min(MAX_STEP_COMPLETION_TOKENS, base * 2 ** depth)
      : base;
  const minimum =
    typeof input.minimumTokens === "number" &&
    Number.isFinite(input.minimumTokens) &&
    input.minimumTokens > 0
      ? Math.floor(input.minimumTokens)
      : 0;
  const withMinimum = Math.min(
    MAX_STEP_COMPLETION_TOKENS,
    Math.max(expanded, minimum),
  );
  const outputTokenLimit =
    typeof input.outputTokenLimit === "number" &&
    Number.isFinite(input.outputTokenLimit) &&
    input.outputTokenLimit > 0
      ? Math.floor(input.outputTokenLimit)
      : undefined;
  return outputTokenLimit === undefined
    ? withMinimum
    : Math.min(withMinimum, outputTokenLimit);
}

export function outputBudgetWasExhausted(input: {
  finishReason?: string | undefined;
  completionTokens?: number | undefined;
  requestedMaxTokens: number;
}): boolean {
  const normalized = input.finishReason
    ?.trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (
    normalized === "length" ||
    normalized === "max_tokens" ||
    normalized === "max_output_tokens" ||
    normalized === "token_limit" ||
    normalized === "output_token_limit"
  ) {
    return true;
  }
  const completionTokens = input.completionTokens ?? 0;
  return (
    completionTokens > 0 &&
    input.requestedMaxTokens > 0 &&
    completionTokens >= input.requestedMaxTokens - 64
  );
}

export function isFreeCloudProvider(provider: ProviderId): boolean {
  return providerCategory[provider] === "free-cloud";
}

export function freeTierGuardNotices(input: {
  provider: ProviderId;
  consecutiveFailures: number;
  policy?: ReliabilityPolicy | undefined;
}): string[] {
  const policy = input.policy ?? getReliabilityPolicy();
  if (!policy.freeTierContextGuard) return [];
  if (!isFreeCloudProvider(input.provider)) return [];
  const notices: string[] = [];
  if (input.consecutiveFailures >= policy.freeTierFailThreshold) {
    notices.push(
      `Free-cloud model failed ${input.consecutiveFailures} time(s) this turn. Switch with /model or /provider, or enable providerFallback for automatic recovery.`,
    );
  }
  return notices;
}

export function hashToolResultContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export function dedupeToolContextOutput(input: {
  content: string;
  toolName: string;
  artifactPath?: string | undefined;
  seenHashes: Map<string, { toolName: string; count: number }>;
  policy?: ReliabilityPolicy | undefined;
}): { content: string; deduped: boolean; hash: string } {
  const policy = input.policy ?? getReliabilityPolicy();
  const hash = hashToolResultContent(input.content);
  if (!policy.toolResultDedup) {
    return { content: input.content, deduped: false, hash };
  }
  if (input.content.length < 400) {
    input.seenHashes.set(hash, {
      toolName: input.toolName,
      count: (input.seenHashes.get(hash)?.count ?? 0) + 1,
    });
    return { content: input.content, deduped: false, hash };
  }
  const prior = input.seenHashes.get(hash);
  if (!prior) {
    input.seenHashes.set(hash, { toolName: input.toolName, count: 1 });
    return { content: input.content, deduped: false, hash };
  }
  prior.count += 1;
  if (prior.count > 2) {
    return { content: input.content, deduped: false, hash };
  }
  const artifact = input.artifactPath
    ? ` Full output: ${input.artifactPath}`
    : "";
  const head = input.content.slice(0, 200).replace(/\s+/g, " ").trim();
  const content =
    `[duplicate tool output — identical to earlier ${prior.toolName} this turn; hash=${hash}]${artifact}\n` +
    `Preview: ${head}${input.content.length > 200 ? "…" : ""}\n` +
    `Re-read the prior tool result or artifact if you need the full body; do not assume it changed.`;
  return { content, deduped: true, hash };
}
