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

// NVIDIA NIM models exposed at integrate.api.nvidia.com use family-specific
// chat-template variables. Sending the wrong variable to a model that does
// not recognise it can leave the upstream renderer in a broken state and
// stream zero tokens — so we route per-family rather than firing every key.
export type NvidiaReasoningKind =
  | "thinking" // DeepSeek-V3/V4, Kimi K2/Nemotron — `chat_template_kwargs.thinking`
  | "enable-thinking" // GLM-5/4.5, Gemma 3/4 — `chat_template_kwargs.enable_thinking`
  | "effort-only" // gpt-oss, qwen3 — top-level `reasoning_effort`
  | "none"; // Llama, Mistral, MiniMax m2.x — no thinking knob

export function classifyNvidiaModel(model: string): NvidiaReasoningKind {
  const m = model.toLowerCase();
  if (/glm-?[345]|gemma-?[34]/.test(m)) return "enable-thinking";
  if (/deepseek-(?:v[34]|r1)|kimi-k2|nemotron/.test(m)) return "thinking";
  if (/gpt-oss|qwen3/.test(m)) return "effort-only";
  return "none";
}

function buildReasoningPayload(
  reasoning: ReasoningPreference | undefined,
  style: ReasoningStyle,
  model?: string,
): Record<string, unknown> {
  if (style === "none") return {};
  const enabled = Boolean(reasoning?.enabled);
  const effort = reasoning?.effort ?? "medium";
  switch (style) {
    case "openai":
      if (!enabled) return {};
      return { reasoning_effort: effort, reasoning: { effort } };
    case "openrouter":
      if (!enabled) return {};
      return { reasoning: { enabled: true, effort } };
    case "groq":
      if (!enabled) return {};
      return { reasoning_effort: effort };
    case "nvidia": {
      // When reasoning is disabled, deliberately send NO chat_template_kwargs
      // and NO reasoning_effort. Empirically NIM's chat templates for kimi /
      // deepseek route an explicit `thinking: false` through a slower path
      // than just omitting the field, and it costs us tens of seconds of
      // latency on otherwise instant models. Keep the body minimal.
      if (!enabled) return {};
      const kind = classifyNvidiaModel(model ?? "");
      switch (kind) {
        case "thinking":
          return {
            chat_template_kwargs: {
              thinking: true,
              reasoning_effort: effort,
            },
          };
        case "enable-thinking":
          return {
            chat_template_kwargs: { enable_thinking: true },
          };
        case "effort-only":
          return { reasoning_effort: effort };
        case "none":
        default:
          return {};
      }
    }
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
    options.model,
  );
  // Reasoning models often spend most of their budget on the hidden
  // <think> stream before emitting any visible answer. If the caller
  // didn't pin a maxTokens, give the model enough headroom (8K when
  // thinking is on, 2K otherwise — keep small for fast non-reasoning
  // paths so kimi-k2.6 etc. respond instantly).
  const reasoningOn = Boolean(options.reasoning?.enabled);
  const defaultMaxTokens = reasoningOn ? 8_192 : 2_048;
  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOpenAiMessages(options.messages),
    max_tokens: options.maxTokens ?? defaultMaxTokens,
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
  /** Abort a stream that produces no bytes for this long. Default 90s. */
  idleTimeoutMs?: number | undefined;
}): Promise<string> {
  // Combine the caller's abort signal with an idle watchdog so a stuck
  // connection on a thinking model can't wedge the REPL forever.
  const idleTimeoutMs = options.idleTimeoutMs ?? 90_000;
  const idleController = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleFired = true;
      idleController.abort();
    }, idleTimeoutMs);
  };
  resetIdleTimer();
  const onCallerAbort = (): void => idleController.abort();
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      signal: idleController.signal,
      headers: {
        "content-type": "application/json",
        // NIM and many OpenAI-compatible gateways start buffering SSE
        // server-side when this header is absent. Always advertise it
        // for stream=true requests so the upstream pushes tokens as
        // soon as they're generated instead of accumulating a chunk.
        accept: "text/event-stream",
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
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    if (idleFired) {
      throw new ProviderError(
        `${options.provider} request timed out before any response (${Math.round(idleTimeoutMs / 1000)}s)`,
      );
    }
    throw error;
  }
  if (!response.ok) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    await readJson<unknown>(response);
  }
  if (!response.body) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    throw new ProviderError(`${options.provider} returned no stream body`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";
  let full = "";
  let visible = "";
  let reasoningSeen = "";
  let inReasoning = false;
  let finishReason: string | undefined;

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

  const cleanup = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          exitReasoning();
          cleanup();
          if (!visible.trim() && reasoningSeen.trim() && finishReason === "length") {
            // The model spent its entire budget on hidden reasoning and
            // never produced a visible answer. Surfacing this as an error
            // — instead of an empty string — is far less confusing than
            // a frozen-looking REPL.
            throw new ProviderError(
              `${options.provider} hit the max_tokens limit while still thinking (no visible answer). Try /variants off, lower the effort, or raise max_tokens.`,
            );
          }
          return full;
        }
        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{
              finish_reason?: string;
              delta?: {
                content?: string;
                reasoning_content?: string;
                reasoning?: string;
              };
            }>;
          };
          const choice = parsed.choices?.[0];
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta;
          const reasoningToken = delta?.reasoning_content ?? delta?.reasoning;
          if (reasoningToken) {
            enterReasoning();
            reasoningSeen += reasoningToken;
            full += reasoningToken;
            options.onToken(reasoningToken);
          }
          const token = delta?.content;
          if (token) {
            if (inReasoning) exitReasoning();
            visible += token;
            full += token;
            options.onToken(token);
          }
        } catch (parseError) {
          if (parseError instanceof ProviderError) throw parseError;
          // Ignore malformed keepalive lines.
        }
      }
    }
    exitReasoning();
    cleanup();
    if (!visible.trim() && reasoningSeen.trim()) {
      throw new ProviderError(
        `${options.provider} ended the stream after only emitting hidden reasoning. Try /variants off, lower the effort, or raise max_tokens.`,
      );
    }
    return full;
  } catch (error) {
    cleanup();
    // reader.cancel() returns a promise that rejects when the underlying
    // stream is already errored (eg from the same abort that triggered
    // this catch). Swallow it so it never escalates to an unhandled
    // rejection that kills the whole REPL.
    try {
      await reader.cancel().catch(() => undefined);
    } catch {
      // best-effort cleanup
    }
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
    if (idleFired) {
      throw new ProviderError(
        `${options.provider} stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s. Try a smaller model or disable thinking with /variants off.`,
      );
    }
    throw error;
  }
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
