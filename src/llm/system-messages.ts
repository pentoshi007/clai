import type { ChatMessage } from "../types.js";

/**
 * Marker prefix used when a mid-conversation `system` message has to be
 * delivered as a user turn because the provider dialect only has a single
 * top-level system field (Anthropic `system`, Gemini `systemInstruction`).
 */
export const SYSTEM_TURN_MARKER = "[SYSTEM]";

/** Mutable, current-turn authority promoted into provider system fields. */
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

/**
 * One shared ordered normalization contract for dialects with a
 * single system slot.
 *
 * The first system message becomes the dialect's system field. Every later
 * system message (compaction memory, live plan, engagement scope, Responder
 * ledger, loop-guard/progress steering) is preserved *in place* as a user turn
 * tagged with {@link SYSTEM_TURN_MARKER}, so ordering relative to tool groups
 * is untouched and nothing is silently dropped.
 *
 * The marker is applied exactly once: content that already carries it is
 * passed through unchanged.
 */
export function normalizeSystemMessages(messages: ChatMessage[]): {
  /** Content of the first system message, if any. */
  systemPrompt: string | undefined;
  /** History with later system messages converted to marked user turns. */
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

/** Content of the first system message, matching the dialect system field. */
export function firstSystemPrompt(
  messages: ChatMessage[],
): string | undefined {
  return messages.find((message) => message.role === "system")?.content;
}
