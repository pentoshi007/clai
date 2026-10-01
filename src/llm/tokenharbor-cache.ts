import type { EphemeralCacheBreakpointMode } from "./wire/chat-body.js";

export type TokenHarborCacheStrategy = "explicit-breakpoints" | "gateway-managed";

const CLAUDE_MODEL_ID = /(?:^|[/:._-])claude(?:[-.]|$)/i;

export function tokenHarborCacheStrategy(model: string): TokenHarborCacheStrategy {
  return CLAUDE_MODEL_ID.test(model) ? "explicit-breakpoints" : "gateway-managed";
}

export function tokenHarborBreakpointMode(
  model: string,
): EphemeralCacheBreakpointMode | undefined {
  return tokenHarborCacheStrategy(model) === "explicit-breakpoints"
    ? "content-block"
    : undefined;
}
