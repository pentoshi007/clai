import type { ChatMessage } from "../types.js";

/**
 * Crude per-char token estimator. Production-grade tokenization differs by
 * provider, but for budgeting an order-of-magnitude heuristic ("chars / 4")
 * is enough to decide when to compact. We deliberately err on the side of
 * over-estimating — better to compact one turn too early than to lose state
 * to a provider context-window error.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let sum = 0;
  for (const message of messages) {
    sum += estimateTokens(message.content) + 4; // role overhead
  }
  return sum;
}

export interface CompactOptions {
  /** Soft budget (tokens). When estimated tokens exceed this, compact. */
  budgetTokens?: number | undefined;
  /** Keep this many trailing messages (system + user/assistant pairs). */
  keepRecent?: number | undefined;
}

const DEFAULT_BUDGET_TOKENS = 24_000;
const DEFAULT_KEEP_RECENT = 8;

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
export function compactMessages(
  messages: ChatMessage[],
  options: CompactOptions = {},
): ChatMessage[] {
  const budget = options.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const keepRecent = Math.max(2, options.keepRecent ?? DEFAULT_KEEP_RECENT);
  if (messages.length <= keepRecent + 1) return messages;
  if (estimateMessagesTokens(messages) <= budget) return messages;

  // Always keep the system prompt (index 0 if it's a system message).
  const head: ChatMessage[] = [];
  let start = 0;
  if (messages[0]?.role === "system") {
    head.push(messages[0]);
    start = 1;
  }

  const tail = messages.slice(Math.max(start, messages.length - keepRecent));
  const middle = messages.slice(start, messages.length - tail.length);
  if (middle.length === 0) return messages;

  const bullets: string[] = [];
  for (const msg of middle) {
    if (msg.role === "user") {
      bullets.push(`- user asked: ${oneLine(msg.content, 200)}`);
    } else if (msg.role === "assistant") {
      const line = oneLine(msg.content, 200);
      if (line) bullets.push(`- assistant: ${line}`);
    } else if (msg.role === "tool") {
      bullets.push(`- tool result: ${oneLine(msg.content, 200)}`);
    }
  }

  const memo: ChatMessage = {
    role: "system",
    content:
      `Earlier turns in this session, summarized to fit the context budget. Full artifacts (when produced) are saved on disk and can be expanded with /output.\n\n` +
      bullets.join("\n"),
  };

  return [...head, memo, ...tail];
}

function oneLine(text: string, maxChars: number): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}
