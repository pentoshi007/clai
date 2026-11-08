import type { EphemeralCacheBreakpointMode } from "./wire/chat-body.js";

export const CLAUDE_MODEL_ID = /(?:^|[/:._-])claude(?:[-.]|$)/i;

export function isClaudeModelId(model: string): boolean {
  return CLAUDE_MODEL_ID.test(model);
}

export function claudeBreakpointMode(
  model: string,
): EphemeralCacheBreakpointMode | undefined {
  return isClaudeModelId(model) ? "content-block" : undefined;
}
