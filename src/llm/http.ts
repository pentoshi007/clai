import type { ChatMessage } from "../types.js";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number | undefined,
    public readonly body?: string | undefined,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export async function readJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      `Provider request failed with HTTP ${response.status}`,
      response.status,
      text.slice(0, 1_000),
    );
  }
  return JSON.parse(text) as T;
}

export function toOpenAiMessages(
  messages: ChatMessage[],
): Array<{ role: string; content: string }> {
  return messages.map((message) => ({
    role: message.role === "tool" ? "user" : message.role,
    content: message.content,
  }));
}

export async function openAiCompatibleComplete(options: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
}): Promise<string> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    signal: options.signal ?? null,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
      ...options.headers,
    },
    body: JSON.stringify({
      model: options.model,
      messages: toOpenAiMessages(options.messages),
      max_tokens: options.maxTokens ?? 1_024,
      temperature: options.temperature ?? 0.2,
      stream: false,
    }),
  });
  const data = await readJson<{
    choices?: Array<{ message?: { content?: string } }>;
  }>(response);
  const text = data.choices?.[0]?.message?.content;
  if (!text) {
    throw new ProviderError(`${options.provider} returned no completion text`);
  }
  return text;
}

export async function openAiCompatiblePing(
  baseUrl: string,
  apiKey: string,
  headers?: Record<string, string> | undefined,
): Promise<void> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...headers,
    },
  });
  await readJson<unknown>(response);
}
