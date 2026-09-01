import type { ChatImage, ChatMessage } from "../../types.js";
import { REQUEST_CONTEXT_PREFIX } from "../../llm/system-messages.js";

export interface TurnMessageInput {
  readonly prompt: string;
  readonly displayPrompt: string | null | undefined;
  readonly images: readonly ChatImage[] | undefined;
  readonly history: readonly ChatMessage[] | undefined;
  readonly systemPrompt: string;
  readonly requestContext: string;
}

export interface AssembledTurnMessages {
  readonly messages: ChatMessage[];
  readonly requestContextMessage: string;
}

export const assembleTurnMessages = (
  input: TurnMessageInput,
): AssembledTurnMessages => {
  const hideUserBubble =
    input.displayPrompt === null || input.displayPrompt === "";
  const userMessage: ChatMessage = {
    role: "user",
    content: input.prompt,
    ...(hideUserBubble ? { internal: true } : {}),
  };
  if (input.images && input.images.length > 0) {
    userMessage.images = [...input.images];
  }
  const requestContextMessage = `${REQUEST_CONTEXT_PREFIX}\n${input.requestContext}`;
  return {
    requestContextMessage,
    messages: [
      { role: "system", content: input.systemPrompt },
      ...(input.history ?? []),
      userMessage,
    ],
  };
};
