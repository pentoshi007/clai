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
    // Try to extract a useful message from the body
    let detail = '';
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const msg = (body as { error?: { message?: string } }).error?.message
        ?? (body as { message?: string }).message
        ?? '';
      if (msg) detail = ` — ${msg}`;
    } catch {
      if (text.length > 0) detail = ` — ${text.slice(0, 200)}`;
    }
    const retryAfter = response.headers.get('retry-after');
    const retryHint = retryAfter ? ` (retry after ${retryAfter}s)` : '';
    throw new ProviderError(
      `Provider request failed with HTTP ${response.status}${retryHint}${detail}`,
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

export async function openAiCompatibleStream(options: {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  headers?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  onToken: (token: string) => void;
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
      stream: true,
    }),
  });
  if (!response.ok) {
    await readJson<unknown>(response);
  }
  if (!response.body)
    throw new ProviderError(`${options.provider} returned no stream body`);

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return full;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{ delta?: { content?: string } }>;
        };
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) {
          full += token;
          options.onToken(token);
        }
      } catch {
        // Ignore malformed keepalive lines.
      }
    }
  }
  return full;
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
