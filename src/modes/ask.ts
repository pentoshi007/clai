import type { ChatMessage, ProviderId } from "../types.js";
import { completeWithProvider, streamWithProvider } from "../llm/router.js";
import { renderAskSystemPrompt } from "../prompts/index.js";
import { getConfig } from "../store/config.js";
import { ensureProviderConfigured } from "../commands/providers.js";
import { loadProjectContext } from "../store/project.js";

export interface AskOptions {
  provider?: ProviderId | undefined;
  model?: string | undefined;
  history?: ChatMessage[] | undefined;
  signal?: AbortSignal | undefined;
}

async function buildAskMessages(
  prompt: string,
  options: AskOptions,
): Promise<{ provider: ProviderId; model: string; messages: ChatMessage[] }> {
  const config = getConfig();
  const provider = options.provider ?? config.defaultProvider;
  await ensureProviderConfigured(provider);
  const projectContext = await loadProjectContext();
  const systemPrompt = projectContext
    ? `${renderAskSystemPrompt()}\n\nProject context from .clai/context.md:\n${projectContext}`
    : renderAskSystemPrompt();
  return {
    provider,
    model: options.model ?? config.defaultModel,
    messages: [
      { role: "system", content: systemPrompt },
      ...(options.history ?? []),
      { role: "user", content: prompt },
    ],
  };
}

export async function runAsk(
  prompt: string,
  options: AskOptions = {},
): Promise<string> {
  const request = await buildAskMessages(prompt, options);
  const result = await completeWithProvider({
    provider: request.provider,
    model: request.model,
    messages: request.messages,
    temperature: 0.2,
    maxTokens: 2_048,
  });

  return result.text;
}

export async function runAskStream(
  prompt: string,
  onToken: (token: string) => void,
  options: AskOptions = {},
): Promise<string> {
  const request = await buildAskMessages(prompt, options);
  const result = await streamWithProvider(
    {
      provider: request.provider,
      model: request.model,
      messages: request.messages,
      temperature: 0.2,
      maxTokens: 2_048,
      signal: options.signal,
    },
    onToken,
  );
  return result.text;
}
