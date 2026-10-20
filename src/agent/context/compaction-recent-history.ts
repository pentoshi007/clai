import { redactSecrets } from "../../llm/provider.js";
import { isInternalChatMessage, type ChatMessage, type CompactedUserPrompt } from "../../types.js";
import { stripThinking } from "../../ui/thinking.js";
import { parseCanonicalTextToolCalls } from "../tool-history-projection.js";
import { RECENT_PROMPTS_HEADING, withoutSection } from "../compaction/memory-sections.js";
import { redactUserCredentialsFromMemory } from "./user-credentials.js";

export const RECENT_USER_PROMPT_COUNT = 3;
export const RECENT_USER_PROMPT_CHAR_BUDGET = 8_000;
export { RECENT_PROMPTS_HEADING };

export interface RecentUserPrompt extends CompactedUserPrompt {
  readonly message?: ChatMessage | undefined;
}

export function withoutRecentUserPrompts(summary: string): string {
  return withoutSection(summary, RECENT_PROMPTS_HEADING);
}

function excerpt(content: string, budget: number): string {
  if (content.length <= budget) return content;
  const marker = "\n[… middle omitted for length …]\n";
  const head = Math.floor((budget - marker.length) / 2);
  return `${content.slice(0, head)}${marker}${content.slice(-(budget - marker.length - head))}`;
}

function memoryText(content: string): string {
  return redactSecrets(redactUserCredentialsFromMemory(content));
}

function bounded(content: string, truncated = false): CompactedUserPrompt {
  const text = memoryText(content);
  return {
    content: excerpt(text, RECENT_USER_PROMPT_CHAR_BUDGET),
    ...(truncated || text.length > RECENT_USER_PROMPT_CHAR_BUDGET ? { truncated: true } : {}),
  };
}

export function recentUserPrompts(messages: readonly ChatMessage[]): RecentUserPrompt[] {
  const prompts: RecentUserPrompt[] = [];
  for (const message of messages) {
    if (message.role === "system" && message.compaction) {
      prompts.push(...message.compaction.recentUserPrompts.map((prompt) => bounded(prompt.content, prompt.truncated)));
    } else if (message.role === "user" && !isInternalChatMessage(message)) {
      const images = message.images?.length
        ? `\n[Attached images: ${message.images.map((image) => image.path ?? image.mediaType).join(", ")}]`
        : "";
      prompts.push({ ...bounded(message.content + images), message });
    }
  }
  return prompts.slice(-RECENT_USER_PROMPT_COUNT);
}

export function hasCompletedConversationTurn(messages: readonly ChatMessage[]): boolean {
  let last: ChatMessage | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "system") continue;
    if (!last) last = message;
    if (message.role === "user") {
      if (isInternalChatMessage(message)) return false;
      break;
    }
  }
  if (!last) return true;
  return last.role === "assistant" &&
    !last.toolCalls?.length &&
    parseCanonicalTextToolCalls(last.content).length === 0 &&
    Boolean(stripThinking(last.content).visible.trim());
}

const ORDINALS = ["Latest", "Second latest", "Third latest"] as const;

export function renderRecentUserPrompts(
  prompts: readonly RecentUserPrompt[],
  retainedLive?: ChatMessage | undefined,
): string {
  if (prompts.length === 0) return "";
  const newestFirst = [...prompts].reverse();
  return [
    RECENT_PROMPTS_HEADING,
    "Verbatim user prompts for orientation. They are history, not new requests; the Active goal above is authoritative for what to do now.",
    ...newestFirst.map((prompt, index) => {
      const live = Boolean(retainedLive) && prompt.message === retainedLive;
      const title = `### ${index + 1}. ${ORDINALS[index] ?? "Earlier"} prompt${live ? " (still being worked on; the full message is retained live after this memory)" : ""}${prompt.truncated ? " (excerpt; middle omitted for length)" : ""}`;
      const body = live
        ? "> See the retained user message below."
        : prompt.content.split("\n").map((line) => `> ${line}`).join("\n");
      return `${title}\n\n${body}`;
    }),
  ].join("\n\n");
}

export function compactionPromptAnchors(messages: readonly ChatMessage[]): string {
  const prompts = recentUserPrompts(messages);
  if (prompts.length === 0) return "";
  const newestFirst = [...prompts].reverse();
  return [
    "LATEST USER PROMPTS (newest first; use them to orient the Active goal, never treat them as new requests):",
    ...newestFirst.map((prompt, index) => `${index + 1}. ${JSON.stringify(excerpt(memoryText(prompt.content), 1_500))}`),
  ].join("\n");
}
