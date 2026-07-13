import type { ChatMessage, ReasoningPreference, ProviderId } from "../types.js";
import { modelSupportsVision } from "./capabilities.js";

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

function statusCodeHint(status: number): string {
  if (status === 401) {
    return " — check that the API key is valid (run `clai providers` to inspect)";
  }
  if (status === 403) {
    return " — the key was rejected (insufficient permissions, billing, or region restriction)";
  }
  if (status === 404) {
    return " — endpoint or model not found (try `/model list` to see supported names)";
  }
  if (status === 422) {
    return " — the provider rejected the request body (model name or parameter mismatch)";
  }
  if (status === 413) {
    return " — request exceeded the provider input limit; retry with a compact prompt or pick another model";
  }
  if (status >= 500 && status < 600) {
    return " — upstream provider error; try again or switch with `/provider`";
  }
  return "";
}

export async function readJson<T>(response: Response): Promise<T> {
  const text = await readBodyCapped(response, MAX_JSON_RESPONSE_BYTES);
  if (!response.ok) {
    // Try to extract a useful message from the body. Some providers (NVIDIA
    // NIM, Groq) wrap errors in `{ error: { message } }`, others (Anthropic)
    // use `{ error: { type, message } }`, and AgentRouter-style proxies
    // sometimes return `{ detail }` or a bare string. Cover the common
    // shapes so users see a helpful message instead of just "HTTP 400".
    let detail = "";
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const error = (body as { error?: unknown }).error;
      let msg = "";
      if (typeof error === "string") {
        msg = error;
      } else if (error && typeof error === "object") {
        const errObj = error as {
          message?: string;
          type?: string;
          code?: string;
        };
        msg = errObj.message ?? "";
        if (!msg && (errObj.type || errObj.code)) {
          msg = errObj.type ?? errObj.code ?? "";
        }
      }
      if (!msg) {
        msg =
          (body as { message?: string }).message ??
          (body as { detail?: string }).detail ??
          "";
      }
      if (msg) {
        // Detect NVIDIA DEGRADED function errors and enrich the message.
        if (/DEGRADED/i.test(msg)) {
          detail = ` — ${msg} (model is temporarily unavailable on this provider; try a different model with \`/model\`)`;
        } else {
          detail = ` — ${msg}`;
        }
      }
    } catch {
      if (text.length > 0) detail = ` — ${text.slice(0, 200)}`;
    }
    const retryAfterSeconds =
      parseRetryAfterHeader(response.headers.get("retry-after")) ??
      parseRetryHintFromBody(text);
    const retryHint =
      retryAfterSeconds !== undefined
        ? ` (retry after ${Math.ceil(retryAfterSeconds)}s)`
        : "";
    const codeHint = statusCodeHint(response.status);
    throw new ProviderError(
      `Provider request failed with HTTP ${response.status}${retryHint}${detail}${codeHint}`,
      response.status,
      text.slice(0, 1_000),
      retryAfterSeconds,
    );
  }
  return JSON.parse(text) as T;
}

/** Hard cap on a JSON response body so a misbehaving provider can't OOM us. */
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Some shapes (eg synthetic Response in tests) don't expose a reader.
    // Fall back to text() but still slice the result so callers see the
    // same cap downstream.
    const text = await response.text();
    return text.length > maxBytes ? text.slice(0, maxBytes) : text;
  }
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let collected = "";
  let bytesRead = 0;
  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        collected += decoder.decode(value.subarray(0, remaining), {
          stream: true,
        });
        bytesRead += remaining;
        try {
          await reader.cancel();
        } catch {
          // ignore — we're abandoning the body deliberately
        }
        break;
      }
      collected += decoder.decode(value, { stream: true });
      bytesRead += value.byteLength;
    }
    collected += decoder.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
  return collected;
}

/** Default no-byte watchdog for provider streams. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * Shared SSE/JSONL stream reader. Wraps a fetch response body in:
 *  - an idle watchdog (default 30s, configurable per call) that aborts
 *    when no bytes arrive,
 *  - a hard total-byte cap (default 16MB) so a runaway provider can't
 *    grow our memory unbounded,
 *  - a caller-provided abort signal.
 *
 * Yields lines as they arrive. Caller is responsible for parsing JSON /
 * SSE `data:` framing. Cleans up timers and reader locks on every exit
 * path so callers don't have to.
 */
export interface StreamLineReaderOptions {
  signal?: AbortSignal | undefined;
  idleTimeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  /** If provided, called after every read so callers can reset their own
   *  watchdogs (eg the OpenAI-compatible streamer's existing one). */
  onActivity?: (() => void) | undefined;
}

/**
 * Read one chunk without allowing a wedged ReadableStream implementation to
 * hide a caller abort. `reader.cancel()` is best-effort: some sockets do not
 * settle an already-pending `read()` promptly, so the abort signal also races
 * the read and rejects the awaiting request immediately.
 */
function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error("Stream aborted"));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => signal.removeEventListener("abort", abort);
    const succeed = (value: ReadableStreamReadResult<Uint8Array>): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void => {
      fail(signal.reason ?? new Error("Stream aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      void reader.read().then(succeed, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export async function* readStreamLines(
  response: Response,
  options: StreamLineReaderOptions = {},
): AsyncGenerator<string, void, void> {
  if (!response.body) return;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
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
  const onCallerAbort = (): void => idleController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  // If either signal is already aborted, bail before starting the loop.
  if (idleController.signal.aborted) {
    if (idleTimer) clearTimeout(idleTimer);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;
  // Cancel the reader when either the idle watchdog or the caller signal
  // fires. ReadableStream.read() doesn't honor an external AbortSignal, so
  // we have to actively cancel the reader for the loop below to unblock.
  const cancelReaderOnAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  idleController.signal.addEventListener("abort", cancelReaderOnAbort, {
    once: true,
  });

  try {
    while (true) {
      if (idleController.signal.aborted) {
        if (idleFired) {
          throw new ProviderError(
            `Provider stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s.`,
          );
        }
        break;
      }
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await readWithAbort(reader, idleController.signal);
      } catch (error) {
        if (idleFired) {
          throw new ProviderError(
            `Provider stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s.`,
          );
        }
        throw error;
      }
      const { done, value } = readResult;
      if (done) {
        if (idleFired) {
          throw new ProviderError(
            `Provider stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s.`,
          );
        }
        break;
      }
      if (value) {
        bytesRead += value.byteLength;
        if (bytesRead > maxBytes) {
          throw new ProviderError(
            `Provider stream exceeded ${maxBytes.toLocaleString()} bytes — aborting.`,
          );
        }
      }
      resetIdleTimer();
      options.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) yield line;
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    idleController.signal.removeEventListener("abort", cancelReaderOnAbort);
    // Do not await cancellation here. A wedged transport can leave
    // `reader.cancel()` pending too; the caller's abort must still return.
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

export function toOpenAiMessages(
  messages: ChatMessage[],
  supportsVision = true,
): Array<{ role: string; content: string | OpenAiContentPart[] }> {
  return messages.map((message) => {
    const role = message.role === "tool" ? "user" : message.role;
    // Attach images as OpenAI-style multimodal content parts (data URLs).
    // Only user messages carry images; everything else stays a plain string
    // so we don't disturb providers/models that expect string content.
    if (
      role === "user" &&
      supportsVision &&
      message.images &&
      message.images.length > 0
    ) {
      const parts: OpenAiContentPart[] = [];
      if (message.content) parts.push({ type: "text", text: message.content });
      for (const img of message.images) {
        parts.push({
          type: "image_url",
          image_url: {
            url: `data:${img.mediaType};base64,${img.dataBase64}`,
            // Request high-detail vision so screenshots/UI images preserve
            // colors, spacing, layout, and small text when providers support it.
            detail: "high",
          },
        });
      }
      return { role, content: parts };
    }
    return { role, content: message.content };
  });
}

export type ReasoningStyle =
  | "openai"
  | "nvidia"
  | "groq"
  | "openrouter"
  | "none";

// NVIDIA NIM models exposed at integrate.api.nvidia.com use family-specific
// chat-template variables. Sending the wrong variable to a model that does
// not recognise it can leave the upstream renderer in a broken state and
// stream zero tokens — so we route per-family rather than firing every key.
export type NvidiaReasoningKind =
  | "kimi-thinking" // Kimi K2.6 — reasoning is on by default; `thinking:false` disables it
  | "deepseek-v4" // DeepSeek V4 — `thinking` plus V4's none/high reasoning effort
  | "thinking" // DeepSeek-R1/V3, older Nemotron — `chat_template_kwargs.thinking`
  | "nemotron-3" // Nemotron-3 — `enable_thinking` + reasoning_budget
  | "glm-thinking" // GLM-5/4.5 — `enable_thinking` + `clear_thinking:false`
  | "enable-thinking" // Gemma 3/4 — `chat_template_kwargs.enable_thinking`
  | "effort-only" // gpt-oss, qwen3, mistral 3+ — top-level `reasoning_effort`
  | "none"; // Llama, MiniMax m2.x, Step, Sarvam — no thinking knob

export function classifyNvidiaModel(model: string): NvidiaReasoningKind {
  const m = model.toLowerCase();
  if (/kimi-k2(?:\.6|-thinking|-instruct)?/.test(m)) return "kimi-thinking";
  if (/deepseek-v4/.test(m)) return "deepseek-v4";
  // Match newer Nemotron-3 (uses enable_thinking + reasoning_budget) before
  // the legacy Nemotron pattern below — the older `nemotron` bucket would
  // otherwise swallow these too.
  if (/nemotron-3/.test(m)) return "nemotron-3";
  if (/glm-?[345]/.test(m)) return "glm-thinking";
  if (/gemma-?[34]/.test(m)) return "enable-thinking";
  if (/deepseek-(?:v3|r1)|nemotron/.test(m)) return "thinking";
  if (/gpt-oss|qwen3|mistral-(?:medium|small|large)-(?:[3-9]|\d{2,})/.test(m))
    return "effort-only";
  return "none";
}

function supportsOpenRouterReasoning(model: string): boolean {
  return /:thinking|deepseek-r1|qwen3|kimi-k2|claude-(?:opus|sonnet|haiku)-4|gpt-5|(?:^|\/)o[134]|grok.*reasoner/i.test(
    model,
  );
}

export function buildReasoningPayload(
  reasoning: ReasoningPreference | undefined,
  style: ReasoningStyle,
  model?: string,
): Record<string, unknown> {
  if (style === "none") return {};
  const enabled = Boolean(reasoning?.enabled);
  const effort = reasoning?.effort ?? "medium";

  // Map expanded effort levels to the classic low/medium/high subset for
  // providers that only understand the smaller set.
  const clampEffort = (e: string): "low" | "medium" | "high" => {
    if (e === "none" || e === "minimal" || e === "low") return "low";
    if (e === "xhigh" || e === "high") return "high";
    return "medium";
  };

  switch (style) {
    case "openai": {
      if (!enabled) return {};
      const clamped = clampEffort(effort);
      return { reasoning_effort: clamped, reasoning: { effort: clamped } };
    }
    case "openrouter":
      if (!enabled) return {};
      if (!supportsOpenRouterReasoning(model ?? "")) return {};
      return { reasoning: { enabled: true, effort: clampEffort(effort) } };
    case "groq": {
      const m = (model ?? "").toLowerCase();
      if (/qwen\/qwen3-32b/.test(m)) {
        return { reasoning_effort: enabled ? "default" : "none" };
      }
      if (/openai\/gpt-oss-(?:20b|120b)/.test(m)) {
        // GPT-OSS cannot disable reasoning effort, but it can hide reasoning
        // from the response. Retrying an empty visible answer must not silently
        // fall back to the provider's medium default effort.
        return enabled
          ? { reasoning_effort: clampEffort(effort), include_reasoning: true }
          : { reasoning_effort: "low", include_reasoning: false };
      }
      return {};
    }
    case "nvidia": {
      const kind = classifyNvidiaModel(model ?? "");
      switch (kind) {
        case "kimi-thinking":
          return {
            chat_template_kwargs: {
              thinking: enabled,
            },
          };
        case "deepseek-v4":
          // NVIDIA's DeepSeek V4 API accepts none/high/max. Map expanded
          // effort levels: none/minimal/low → none; medium/high/xhigh → high.
          return {
            chat_template_kwargs: {
              thinking: enabled,
              reasoning_effort: enabled
                ? clampEffort(effort) === "low"
                  ? "none"
                  : "high"
                : "none",
            },
          };
        case "thinking":
          return {
            chat_template_kwargs: {
              thinking: enabled,
            },
          };
        case "nemotron-3": {
          // Nemotron-3 supports both `enable_thinking` and an optional
          // `reasoning_budget` cap. Map expanded effort to budget values.
          if (!enabled) {
            return {
              chat_template_kwargs: { enable_thinking: false },
            };
          }
          const clamped = clampEffort(effort);
          const budget =
            clamped === "low" ? 4_096 : clamped === "high" ? 16_384 : 8_192;
          return {
            reasoning_budget: budget,
            chat_template_kwargs: { enable_thinking: true },
          };
        }
        case "glm-thinking":
          // GLM-5 / 4.5 expects `clear_thinking:false` alongside
          // `enable_thinking:true` per the NIM docs example.
          return {
            chat_template_kwargs: enabled
              ? { enable_thinking: true, clear_thinking: false }
              : { enable_thinking: false },
          };
        case "enable-thinking":
          // Gemma 3/4 only documents `enable_thinking`; do not add
          // `clear_thinking` here since the chat template doesn't accept it.
          return {
            chat_template_kwargs: { enable_thinking: enabled },
          };
        case "effort-only":
          // NVIDIA GPT-OSS accepts only low/medium/high, so a retry cannot
          // fully disable it. Keep it at the lowest supported effort instead
          // of omitting the field and reverting to NVIDIA's medium default.
          if (!enabled && /gpt-oss/i.test(model ?? "")) {
            return { reasoning_effort: "low" };
          }
          if (!enabled && /qwen3|mistral-/i.test(model ?? "")) {
            return { reasoning_effort: "none" };
          }
          return { reasoning_effort: clampEffort(effort) };
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
  supportsVision?: boolean | undefined;
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
  // Kimchi exposes this model as `minimax-m3`; NVIDIA uses the longer
  // `minimaxai/minimax-m3` ID. Both require the same sampling settings.
  const isMinimaxM3 = /minimax-m3/i.test(options.model);
  const defaultMaxTokens = isMinimaxM3 ? 8_192 : reasoningOn ? 8_192 : 4_096;
  const defaultTemperature = isMinimaxM3 ? 1.0 : 0.2;
  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOpenAiMessages(options.messages, options.supportsVision),
    max_tokens: options.maxTokens ?? defaultMaxTokens,
    temperature: options.temperature ?? defaultTemperature,
    stream: options.stream,
    ...reasoning,
  };
  if (isMinimaxM3) {
    body.top_p = 0.95;
  }
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
  const supportsVision = modelSupportsVision(
    options.provider.toLowerCase() as ProviderId,
    options.model,
  );
  const requestBody = buildChatBody({
    model: options.model,
    messages: options.messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    stream: false,
    reasoning: options.reasoning,
    reasoningStyle: options.reasoningStyle,
    supportsVision,
  });
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      signal: options.signal ?? null,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${options.apiKey}`,
        ...options.headers,
      },
      body: requestBody,
      verbose: process.env.CLAI_VERBOSE === "true",
    } as any);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    const msg = error instanceof Error ? error.message : String(error);
    throw new ProviderError(
      `${options.provider} request could not be sent (${msg}). Check connectivity to ${options.baseUrl}.`,
    );
  }
  let data: {
    choices?: Array<{
      message?: {
        content?: string;
        reasoning_content?: string;
        reasoning?: string;
      };
    }>;
  };
  try {
    data = await readJson(response);
  } catch (error) {
    if (error instanceof ProviderError) {
      throw new ProviderError(
        `${options.provider} (model=${options.model}): ${error.message}`,
        error.status,
        error.body,
        error.retryAfterSeconds,
      );
    }
    throw error;
  }
  const message = data.choices?.[0]?.message;
  const text = message?.content;
  if (!text) {
    throw new ProviderError(
      `${options.provider} returned no completion text (model=${options.model}). The response was empty — try /variants off, raise max_tokens, or pick another model with /model.`,
    );
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
  /** Abort a stream that produces no bytes for this long. Default 30s. */
  idleTimeoutMs?: number | undefined;
  /**
   * Allow a slower cold start before the first SSE byte. Once streaming has
   * begun, `idleTimeoutMs` takes over so a wedged connection still aborts
   * promptly. Defaults to the regular idle timeout.
   */
  initialIdleTimeoutMs?: number | undefined;
}): Promise<string> {
  // Combine the caller's abort signal with an idle watchdog so a stuck
  // connection on a thinking model can't wedge the REPL forever.
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const initialIdleTimeoutMs = options.initialIdleTimeoutMs ?? idleTimeoutMs;
  const idleController = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  let sawStreamBytes = false;
  let activeIdleTimeoutMs = initialIdleTimeoutMs;
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    activeIdleTimeoutMs = sawStreamBytes ? idleTimeoutMs : initialIdleTimeoutMs;
    idleTimer = setTimeout(() => {
      idleFired = true;
      idleController.abort();
    }, activeIdleTimeoutMs);
  };
  resetIdleTimer();
  const onCallerAbort = (): void => idleController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const supportsVision = modelSupportsVision(
    options.provider.toLowerCase() as ProviderId,
    options.model,
  );
  const requestBody = buildChatBody({
    model: options.model,
    messages: options.messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    stream: true,
    reasoning: options.reasoning,
    reasoningStyle: options.reasoningStyle,
    supportsVision,
  });
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
      body: requestBody,
      verbose: process.env.CLAI_VERBOSE === "true",
    } as any);
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    if (idleFired) {
      throw new ProviderError(
        `${options.provider} request timed out before any response (${Math.round(activeIdleTimeoutMs / 1000)}s)`,
      );
    }
    throw error;
  }
  if (!response.ok) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    try {
      await readJson<unknown>(response);
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new ProviderError(
          `${options.provider} (model=${options.model}): ${error.message}`,
          error.status,
          error.body,
          error.retryAfterSeconds,
        );
      }
      throw error;
    }
  }
  if (!response.body) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    throw new ProviderError(`${options.provider} returned no stream body`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 202 || /\bapplication\/json\b/i.test(contentType)) {
    if (idleTimer) clearTimeout(idleTimer);
    options.signal?.removeEventListener("abort", onCallerAbort);
    const data = await readJson<{
      id?: string;
      requestId?: string;
      status?: string;
      choices?: Array<{
        message?: {
          content?: string;
          reasoning_content?: string;
          reasoning?: string;
        };
      }>;
    }>(response);
    if (response.status === 202) {
      const requestId = data.requestId ?? data.id;
      throw new ProviderError(
        `${options.provider} returned a pending async response${requestId ? ` (${requestId})` : ""}; streaming did not start.`,
        response.status,
        JSON.stringify(data).slice(0, 1_000),
      );
    }
    const message = data.choices?.[0]?.message;
    const text = message?.content ?? "";
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    const full =
      reasoning && reasoning.trim()
        ? `<think>${reasoning}</think>${text}`
        : text;
    if (full.trim()) {
      options.onToken(full);
      return full;
    }
    throw new ProviderError(
      `${options.provider} returned JSON instead of an SSE stream, but no completion text was present.`,
      response.status,
      JSON.stringify(data).slice(0, 1_000),
    );
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
    idleController.signal.removeEventListener("abort", cancelReaderOnAbort);
  };
  const cancelReaderOnAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  idleController.signal.addEventListener("abort", cancelReaderOnAbort, {
    once: true,
  });

  try {
    while (true) {
      options.signal?.throwIfAborted();
      if (idleController.signal.aborted) {
        throw new Error("Stream aborted");
      }
      const { done, value } = await readWithAbort(reader, idleController.signal);
      options.signal?.throwIfAborted();
      if (idleController.signal.aborted) {
        throw new Error("Stream aborted");
      }
      if (done) break;
      sawStreamBytes = true;
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
          if (!visible.trim()) {
            const cause = reasoningSeen.trim()
              ? finishReason === "length"
                ? "hit the max_tokens limit while still thinking"
                : "completed after reasoning without a visible answer"
              : "completed without a visible answer";
            // Do not return a reasoning-only completion to the agent. It
            // would poison recovery history and cause no-op retry loops.
            // Router-level fallback can now try a healthy provider instead.
            throw new ProviderError(
              `${options.provider} ${cause}.`,
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
    if (!visible.trim()) {
      const cause = reasoningSeen.trim()
        ? finishReason === "length"
          ? "hit the max_tokens limit while still thinking"
          : "completed after reasoning without a visible answer"
        : "completed without a visible answer";
      throw new ProviderError(
        `${options.provider} ${cause}.`,
      );
    }
    return full;
  } catch (error) {
    cleanup();
    // reader.cancel() returns a promise that rejects when the underlying
    // stream is already errored (eg from the same abort that triggered
    // this catch). Swallow it so it never escalates to an unhandled
    // rejection that kills the whole REPL.
    // Do not await cancellation here. Some stalled sockets never settle the
    // pending cancel promise, and waiting for it would negate the abort race.
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
    if (idleFired) {
      throw new ProviderError(
        `${options.provider} stream stalled — no data for ${Math.round(activeIdleTimeoutMs / 1000)}s. Try a smaller model or disable thinking with /variants off.`,
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
    verbose: process.env.CLAI_VERBOSE === "true",
  } as any);
  await readJson<unknown>(response);
}
