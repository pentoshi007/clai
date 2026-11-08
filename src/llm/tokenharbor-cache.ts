import { claudeBreakpointMode, isClaudeModelId } from "./claude-breakpoints.js";
import type { EphemeralCacheBreakpointMode } from "./wire/chat-body.js";

export type TokenHarborCacheStrategy = "explicit-breakpoints" | "gateway-managed";

export function tokenHarborCacheStrategy(model: string): TokenHarborCacheStrategy {
  return isClaudeModelId(model) ? "explicit-breakpoints" : "gateway-managed";
}

export function tokenHarborBreakpointMode(
  model: string,
): EphemeralCacheBreakpointMode | undefined {
  return claudeBreakpointMode(model);
}
