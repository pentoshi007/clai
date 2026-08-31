import type { ChatMessage } from "../types.js";

export const SYSTEM_TURN_MARKER = "[SYSTEM]";

export const REQUEST_CONTEXT_PREFIX = "REQUEST CONTEXT";

export function isRequestContextSystemMessage(message: ChatMessage): boolean {
  return (
    message.role === "system" &&
    message.content.startsWith(REQUEST_CONTEXT_PREFIX)
  );
}

export function requestContextSystemPrompts(
  messages: readonly ChatMessage[],
): string[] {
  return messages
    .filter(isRequestContextSystemMessage)
    .map((message) => message.content);
}

export function withoutRequestContextSystemMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  return messages.filter((message) => !isRequestContextSystemMessage(message));
}

export function upsertRequestContextMessage(
  messages: ChatMessage[],
  content: string,
): void {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRequestContextSystemMessage(messages[index]!)) messages.splice(index, 1);
  }
  messages.push({ role: "system", content });
}

export function normalizeSystemMessages(messages: ChatMessage[]): {
  systemPrompt: string | undefined;
  rest: ChatMessage[];
} {
  let systemPrompt: string | undefined;
  let seenFirstSystem = false;
  const rest: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system") {
      rest.push(message);
      continue;
    }
    if (!seenFirstSystem) {
      seenFirstSystem = true;
      systemPrompt = message.content;
      continue;
    }
    rest.push({
      ...message,
      role: "user",
      content: markSystemTurn(message.content),
    });
  }
  return { systemPrompt, rest };
}

export function singleLeadingSystemMessages(
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const { systemPrompt, rest } = normalizeSystemMessages([...messages]);
  return systemPrompt === undefined
    ? rest
    : [{ role: "system", content: systemPrompt }, ...rest];
}

export function markSystemTurn(content: string): string {
  return content.startsWith(SYSTEM_TURN_MARKER)
    ? content
    : `${SYSTEM_TURN_MARKER}\n${content}`;
}

export function firstSystemPrompt(
  messages: ChatMessage[],
): string | undefined {
  return messages.find((message) => message.role === "system")?.content;
}
