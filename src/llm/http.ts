import type { ChatMessage, ReasoningPreference } from "../types.js";

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number | undefined,
    public readonly body?: string | undefined,
    public readonly retryAfterSeconds?: number | undefined,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function parseRetryAfterHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number.parseFloat(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  // HTTP-date form: "Wed, 21 Oct 2015 07:28:00 GMT"
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    const diff = (date - Date.now()) / 1000;
    if (diff > 0) return diff;
  }
  return undefined;
}

function parseRetryHintFromBody(text: string): number | undefined {
  const match = text.match(/try again in\s+([0-9.]+)\s*s/i);
  if (match) {
    const seconds = Number.parseFloat(match[1]!);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  }
  return undefined;
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
    const retryAfterSeconds =
      parseRetryAfterHeader(response.headers.get('retry-after'))
      ?? parseRetryHintFromBody(text);
    const retryHint = retryAfterSeconds !== undefined
      ? ` (retry after ${Math.ceil(retryAfterSeconds)}s)`
      : '';
    throw new ProviderError(
      `Provider request failed with HTTP ${response.status}${retryHint}${detail}`,
      response.status,
      text.slice(0, 1_000),
      retryAfterSeconds,
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

export type ReasoningStyle = "openai" | "nvidia" | "groq" | "openrouter" | "none";

function buildReasoningPayload(
  reasoning: ReasoningPreference | undefined,
  style: ReasoningStyle,
): Record<string, unknown> {
  if (!reasoning?.enabled || style === "none") return {};
  const effort = reasoning.effort;
  switch (style) {
    case "openai":
      // GPT-5/o-series: supply both reasoning_effort (legacy) and the
      // newer `reasoning: { effort }` so we work across recent SDKs.
      return { reasoning_effort: effort, reasoning: { effort } };
    case "openrouter":
      return { reasoning: { enabled: true, effort } };
    case "groq":
      // Groq's Kimi/DeepSeek reasoning routes accept reasoning_effort.
      return { reasoning_effort: effort };
    case "nvidia":
      // NVIDIA NIM toggles thinking via chat_template_kwargs.
      return { chat_template_kwargs: { thinking: true } };
    default:
      return {};
  }
}

function buildChatBody(options: {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  stream: boolean;
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
}): string {
  const reasoning = buildReasoningPayload(
    options.reasoning,
    options.reasoningStyle ?? "none",
  );
  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOpenAiMessages(options.messages),
    max_tokens: options.maxTokens ?? 1_024,
    temperature: options.temperature ?? 0.2,
    stream: options.stream,
    ...reasoning,
  };
  return JSON.stringify(body);
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
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
}): Promise<string> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    signal: options.signal ?? null,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
      ...options.headers,
    },
    body: buildChatBody({
      model: options.model,
      messages: options.messages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      stream: false,
      reasoning: options.reasoning,
      reasoningStyle: options.reasoningStyle,
    }),
  });
  const data = await readJson<{
    choices?: Array<{
      message?: { content?: string; reasoning_content?: string; reasoning?: string };
    }>;
  }>(response);
  const message = data.choices?.[0]?.message;
  const text = message?.content;
  if (!text) {
    throw new ProviderError(`${options.provider} returned no completion text`);
  }
  // If the API returns reasoning separately, prepend it inside <think>
  // tags so the existing thinking parser can pick it up uniformly.
  const reasoning = message?.reasoning_content ?? message?.reasoning;
  if (reasoning && reasoning.trim()) {
    return `<think>${reasoning}</think>${text}`;
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
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
}): Promise<string> {
  const response = await fetch(`${options.baseUrl}/chat/completions`, {
    method: "POST",
    signal: options.signal ?? null,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.apiKey}`,
      ...options.headers,
    },
    body: buildChatBody({
      model: options.model,
      messages: options.messages,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      stream: true,
      reasoning: options.reasoning,
      reasoningStyle: options.reasoningStyle,
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
  let inReasoning = false;

  const enterReasoning = (): void => {
    if (inReasoning) return;
    inReasoning = true;
    full += "<think>";
    options.onToken("<think>");
  };
  const exitReasoning = (): void => {
    if (!inReasoning) return;
    inReasoning = false;
    full += "</think>";
    options.onToken("</think>");
  };

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
      if (payload === "[DONE]") {
        exitReasoning();
        return full;
      }
      try {
        const parsed = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string;
              reasoning_content?: string;
              reasoning?: string;
            };
          }>;
        };
        const delta = parsed.choices?.[0]?.delta;
        const reasoningToken = delta?.reasoning_content ?? delta?.reasoning;
        if (reasoningToken) {
          enterReasoning();
          full += reasoningToken;
          options.onToken(reasoningToken);
        }
        const token = delta?.content;
        if (token) {
          if (inReasoning) exitReasoning();
          full += token;
          options.onToken(token);
        }
      } catch {
        // Ignore malformed keepalive lines.
      }
    }
  }
  exitReasoning();
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
