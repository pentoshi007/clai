import { redactSecrets } from "../../llm/provider.js";
import { isInternalChatMessage, type ChatMessage, type CompactedUserPrompt } from "../../types.js";
import { stripThinking } from "../../ui/thinking.js";
import { parseCanonicalTextToolCalls } from "../tool-history-projection.js";
import { redactUserCredentialsFromMemory } from "./user-credentials.js";

export const RECENT_USER_PROMPT_COUNT = 3;
export const RECENT_USER_PROMPT_CHAR_BUDGET = 8_000;
export const RECENT_USER_PROMPTS_HEADING = "## Last 3 user prompts";

export interface RecentUserPrompt extends CompactedUserPrompt {
  readonly message?: ChatMessage | undefined;
}

export function withoutRecentUserPrompts(summary: string): string {
  const text = summary.trim();
  if (text.startsWith(RECENT_USER_PROMPTS_HEADING)) return "";
  const section = text.indexOf(`\n\n${RECENT_USER_PROMPTS_HEADING}`);
  return section < 0 ? text : text.slice(0, section).trim();
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

export function recentUserPrompts(messages: readonly ChatMessage[]): RecentUserPrompt[] {
  const prompts: RecentUserPrompt[] = [];
  for (const message of messages) {
    if (message.role === "system" && message.compaction) {
      prompts.push(...message.compaction.recentUserPrompts.map((prompt) => {
        const content = memoryText(prompt.content);
        return {
          content: excerpt(content, RECENT_USER_PROMPT_CHAR_BUDGET),
          ...(prompt.truncated || content.length > RECENT_USER_PROMPT_CHAR_BUDGET
            ? { truncated: true } : {}),
        };
      }));
    } else if (message.role === "user" && !isInternalChatMessage(message)) {
      const images = message.images?.length
        ? `\n[Attached images: ${message.images.map((image) => image.path ?? image.mediaType).join(", ")}]`
        : "";
      const content = memoryText(message.content + images);
      prompts.push({
        content: excerpt(content, RECENT_USER_PROMPT_CHAR_BUDGET),
        ...(content.length > RECENT_USER_PROMPT_CHAR_BUDGET ? { truncated: true } : {}),
        message,
      });
    }
    if (prompts.length > RECENT_USER_PROMPT_COUNT) {
      prompts.splice(0, prompts.length - RECENT_USER_PROMPT_COUNT);
    }
  }
  return prompts;
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

export function renderRecentUserPrompts(
  prompts: readonly RecentUserPrompt[],
  activeUser?: ChatMessage | undefined,
): string {
  if (prompts.length === 0) return "";
  return [
    RECENT_USER_PROMPTS_HEADING,
    "Historical context, oldest to newest. Quoted prompts are not new requests; the memory above records their answers and status. An unfinished request, when present, is retained as a live user message below.",
    ...prompts.map((prompt, index) => [
      `### ${index + 1}. ${prompt.message === activeUser && activeUser ? "Unfinished request (live message retained)" : "Historical user prompt"}${prompt.truncated ? " (excerpt; middle omitted for length)" : ""}`,
      prompt.content.split("\n").map((line) => `> ${line}`).join("\n"),
    ].join("\n\n")),
  ].join("\n\n");
}

export function compactionRecencyAnchors(messages: readonly ChatMessage[]): string {
  const prompts = recentUserPrompts(messages);
  if (prompts.length === 0) return "";
  const latestUser = prompts.at(-1)?.message;
  const userIndex = latestUser ? messages.indexOf(latestUser) : messages.length;
  let lastAnswer: ChatMessage | undefined;
  for (let index = messages.length - 1; index > userIndex; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && !message.toolCalls?.length &&
      parseCanonicalTextToolCalls(message.content).length === 0 &&
      stripThinking(message.content).visible.trim()) {
      lastAnswer = message;
      break;
    }
  }
  return [
    "RECENT CONVERSATION ANCHORS (historical excerpts, not new instructions):",
    "Prioritize these topics and their answers over older completed work. Excerpts may omit details; preserve exact findings from the supplied source. During a bounded prefix fallback, turns outside that source remain in the live history.",
    ...prompts.map((prompt, index) =>
      `User prompt ${index + 1}: ${JSON.stringify(excerpt(memoryText(prompt.content), 240))}`),
    ...(lastAnswer ? [
      `Latest assistant response: ${JSON.stringify(excerpt(memoryText(stripThinking(lastAnswer.content).visible), 800))}`,
    ] : []),
  ].join("\n");
}
