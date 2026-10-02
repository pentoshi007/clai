import { isInternalChatMessage, type ChatMessage } from "../../types.js";

export function latestUserMessage(
  messages: readonly ChatMessage[],
): ChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && !isInternalChatMessage(message)) return message;
  }
  return undefined;
}
