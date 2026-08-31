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


export const AUTO_COMPACT_TOKEN_BUDGET = 180_000;

export const POST_COMPACT_SOFT_GUIDANCE_TOKENS = 16_000;

export const AUTO_COMPACT_STUB_MIN_CHARS = 120;
export const AUTO_COMPACT_STUB_BEFORE_TOKENS = 20_000;

const DEFAULT_BUDGET_TOKENS = 32_000;

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

export function shouldApplyAutoCompact(input: {
  summarized: boolean;
  summaryBody: string;
  beforeTokens: number;
  afterTokens: number;
  afterMessages: readonly ChatMessage[];
}): boolean {
  if (!input.summarized) return false;
  if (input.afterTokens >= input.beforeTokens) return false;
  if (hasOrphanToolMessages([...input.afterMessages])) return false;
  const body = input.summaryBody.trim();
  if (!body) return false;
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
