import type { ChatMessage, ProviderId } from "../types.js";
import { completeWithProvider } from "../llm/router.js";
import { renderAskSystemPrompt } from "../prompts/index.js";
import { getConfig } from "../store/config.js";

export interface AskOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
}

export async function runAsk(
  prompt: string,
  options: AskOptions = {},
): Promise<string> {
  const config = getConfig();
  const messages: ChatMessage[] = [
    { role: "system", content: renderAskSystemPrompt() },
    ...(options.history ?? []),
    { role: "user", content: prompt },
  ];

  const result = await completeWithProvider({
    provider: options.provider ?? config.defaultProvider,
    model: options.model ?? config.defaultModel,
    messages,
    temperature: 0.2,
    maxTokens: 1_500,
  });

  return result.text;
}
