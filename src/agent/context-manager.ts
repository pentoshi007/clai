import type { ChatMessage } from "../types.js";
import { stripThinking } from "../ui/thinking.js";
import {
  hasReasoningMarker,
  stripReasoningMarkers,
} from "../llm/reasoning-marker.js";
import {
  expandKeepStartForToolPairs,
  hasOrphanToolMessages,
} from "./tool-history.js";
import { isResponderResultLedgerMessage } from "./responder-context.js";
import {
  estimateImageTokens,
  estimateMessagesTokens,
  estimateTextTokens as estimateTokens,
} from "./request-accounting.js";
import { CompactOptions, DEFAULT_KEEP_RECENT, MECHANICAL_MEMORY_PREFIX, isCompactionMemoryMessage } from "./context/compact-with-summary.js";
export { COMPACTION_MEMORY_PREFIX, PLAN_IMPLEMENT_MEMORY_PREFIX, POST_COMPACT_SOFT_UPPER_BAND_TOKENS, compactMessagesWithSummary, compactionMemoryPrefixForPurpose } from "./context/compact-with-summary.js";
export { MECHANICAL_MEMORY_PREFIX, isCompactionMemoryMessage };
export type { CompactOptions, CompactResult, CompactionStrategy, CompactionSummaryStage } from "./context/compact-with-summary.js";

export { estimateImageTokens, estimateMessagesTokens, estimateTokens };

/**
 * Token estimation lives in `request-accounting.ts` — the one serialized-
 * request accounting service. The exports above keep this module's historic
 * public surface; nothing here owns a chars-per-token ratio anymore.
 */

/**
 * Agent-loop auto-compact threshold (estimated tokens). Shared with `/context`
 * so the reported % of budget matches when auto-compaction fires.
 *
 * 180k: provider/model-neutral default. A session-specific model window can
 * opt into a 70%-of-window trigger.
 */
export const AUTO_COMPACT_TOKEN_BUDGET = 180_000;

/**
 * Soft post-compact band we *prefer* (includes system prompt ~8k).
 * Achieved by dense memory + progressive soft-trim of oversized dumps only.
 * Never a reject gate, never drops messages/tool pairs to hit the number.
 */
export const POST_COMPACT_SOFT_GUIDANCE_TOKENS = 16_000;

/** Auto-compact: reject empty/near-empty memory after large history (amnesia). */
export const AUTO_COMPACT_STUB_MIN_CHARS = 120;
export const AUTO_COMPACT_STUB_BEFORE_TOKENS = 20_000;

const DEFAULT_BUDGET_TOKENS = 32_000;

/**
 * Replace older messages with a single condensed "memory" message while
 * preserving the system prompt and the most recent N messages.
 *
 * We do not call the LLM here — that's a future enhancement. The current
 * compaction is mechanical: keep the system prompt; replace the prefix of
 * older turns with a bullet list of the assistant's last lines and the
 * tool calls that produced output. This is conservative and reversible
 * (the artifact files still hold the raw outputs).
 */
function assistantVisibleOnly(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  if (
    !hasReasoningMarker(message.content) &&
    !/^\s*<think(?:ing)?\b/i.test(message.content)
  ) {
    return message;
  }
  const visible = stripThinking(message.content).visible;
  return {
    ...message,
    content: visible || stripReasoningMarkers(message.content),
  };
}

export function compactMessages(
  messages: ChatMessage[],
  options: CompactOptions = {},
): ChatMessage[] {
  const budget = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const keepRecent = Math.max(2, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  if (messages.length <= keepRecent + 1) return messages;
  if (estimateMessagesTokens(messages) <= budget) return messages;

  // Keep the real system prompt, but never pin prior compaction memory as
  // the head: re-compaction must summarize/replace that stale memory.
  const head: ChatMessage[] = [];
  let start = 0;
  if (
    messages[0]?.role === "system" &&
    !isCompactionMemoryMessage(messages[0])
  ) {
    head.push(messages[0]);
    start = 1;
  }

  let tailStart = Math.max(start, messages.length - keepRecent);
  tailStart = expandKeepStartForToolPairs(messages, tailStart);
  const tail = messages.slice(tailStart).map(assistantVisibleOnly);
  const middle = messages.slice(start, tailStart);
  if (middle.length === 0) return messages;

  const bullets: string[] = [];
  for (const raw of middle) {
    const msg = assistantVisibleOnly(raw);
    if (msg.role === "user") {
      bullets.push(`- user asked: ${oneLine(msg.content, 200)}`);
    } else if (msg.role === "assistant") {
      const line = oneLine(msg.content, 200);
      if (line) bullets.push(`- assistant: ${line}`);
      if (msg.toolCalls?.length) {
        bullets.push(
          `- assistant tools: ${msg.toolCalls.map((t) => t.name).join(", ")}`,
        );
      }
    } else if (msg.role === "tool") {
      bullets.push(`- tool result: ${oneLine(msg.content, 200)}`);
    }
  }

  const memo: ChatMessage = {
    role: "system",
    content:
      `${MECHANICAL_MEMORY_PREFIX} to fit the context budget. Full artifacts (when produced) are saved on disk and can be expanded with /output.\n\n` +
      bullets.join("\n"),
  };

  let ledger: ChatMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isResponderResultLedgerMessage(messages[index]!)) {
      ledger = messages[index];
      break;
    }
  }
  const preservedLedger =
    ledger && !head.includes(ledger) && !tail.includes(ledger) ? [ledger] : [];
  return [...head, memo, ...preservedLedger, ...tail];
}

/**
 * Whether an auto-compact result is safe to apply.
 * Only structural / quality gates — never "afterTokens must be under N".
 */
export function shouldApplyAutoCompact(input: {
  summarized: boolean;
  summaryBody: string;
  beforeTokens: number;
  afterTokens: number;
  afterMessages: readonly ChatMessage[];
}): boolean {
  if (!input.summarized) return false;
  // Must actually shrink (otherwise pointless and can thrash).
  if (input.afterTokens >= input.beforeTokens) return false;
  if (hasOrphanToolMessages([...input.afterMessages])) return false;
  const body = input.summaryBody.trim();
  if (!body) return false;
  // Amnesia stub only — not a target-size check.
  if (
    input.beforeTokens >= AUTO_COMPACT_STUB_BEFORE_TOKENS &&
    body.length < AUTO_COMPACT_STUB_MIN_CHARS
  ) {
    return false;
  }
  return true;
}

function oneLine(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}
