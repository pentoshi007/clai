import type {
  ChatMessage,
  NativeToolCall,
  ReasoningPreference,
  ProviderId,
  TokenUsage,
  ToolChoice,
  ToolDefinition,
} from "../types.js";
import {
  modelAcceptsImages,
  modelSupportsThinking,
  isReasoningUnsupported,
  modelReasoningEfforts,
  learnModelEmitsReasoning,
  registerModelCatalog,
  type CatalogModel,
} from "./capabilities.js";
import { resolveSampling } from "./sampling.js";
import {
  accumulateOpenAiToolCallDelta,
  finalizeOpenAiToolCalls,
  fromWireName,
  parseOpenAiMessageToolCalls,
} from "./tool-protocol.js";
import {
  openAiToolBodyFields,
  toOpenAiToolMessages,
} from "./adapters/openai-tools.js";
import { parseOpenAiUsage } from "./token-usage.js";
import {
  REASONING_CLOSE,
  REASONING_OPEN,
  wrapReasoning,
} from "./reasoning-marker.js";

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

interface RawCatalogEntry {
  id?: string;
  vision?: unknown;
  supports_vision?: unknown;
  multimodal?: unknown;
  modalities?: unknown;
  input_modalities?: unknown;
  architecture?: { input_modalities?: unknown; modality?: unknown };
  capabilities?: unknown;
  features?: unknown;
}

function modalitiesDeclareImage(value: unknown): boolean | undefined {
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string");
    if (items.length === 0) return undefined;
    return items.some((item) => /image|vision/i.test(item));
  }
  if (typeof value === "string") {
    if (!/text|image|audio|video/i.test(value)) return undefined;
    return /image|vision/i.test(value);
  }
  if (value && typeof value === "object") {
    const nested = value as { input?: unknown; image?: unknown; vision?: unknown };
    if (typeof nested.vision === "boolean") return nested.vision;
    if (typeof nested.image === "boolean") return nested.image;
    if (nested.input !== undefined) return modalitiesDeclareImage(nested.input);
  }
  return undefined;
}

export function catalogEntryVision(entry: unknown): boolean | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const raw = entry as RawCatalogEntry;
  for (const flag of [raw.vision, raw.supports_vision, raw.multimodal]) {
    if (typeof flag === "boolean") return flag;
  }
  for (const candidate of [
    raw.architecture?.input_modalities,
    raw.architecture?.modality,
    raw.input_modalities,
    raw.modalities,
    raw.capabilities,
    raw.features,
  ]) {
    const declared = modalitiesDeclareImage(candidate);
    if (declared !== undefined) return declared;
  }
  return undefined;
}

const REASONING_FEATURE_RE =
  /^(?:reasoning|reasoning_effort|include_reasoning|thinking|reasoning_content)$/i;

function catalogEntryReasoning(entry: unknown): boolean | undefined {
  const raw = entry as
    | {
        reasoning?: unknown;
        reasoning_options?: unknown;
        supported_features?: unknown;
        supported_parameters?: unknown;
        features?: unknown;
        capabilities?: unknown;
      }
    | undefined;
  if (typeof raw?.reasoning === "boolean") return raw.reasoning;
  if (Array.isArray(raw?.reasoning_options) && raw.reasoning_options.length > 0) {
    return true;
  }
  for (const container of [
    raw?.supported_features,
    raw?.supported_parameters,
    raw?.features,
    raw?.capabilities,
  ]) {
    if (!Array.isArray(container)) continue;
    const names = container.filter(
      (value): value is string => typeof value === "string",
    );
    if (names.length === 0) continue;
    return names.some((name) => REASONING_FEATURE_RE.test(name.trim()));
  }
  return undefined;
}

function catalogEntryReasoningEfforts(entry: unknown): string[] | undefined {
  const raw = entry as
    | {
        reasoning_options?: unknown;
        supported_reasoning_efforts?: unknown;
        reasoning_effort?: unknown;
      }
    | undefined;
  const collected: string[] = [];
  const pushValues = (values: unknown): void => {
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (typeof value === "string" && value.trim()) collected.push(value.trim());
    }
  };
  if (Array.isArray(raw?.reasoning_options)) {
    for (const option of raw.reasoning_options) {
      const shaped = option as { type?: unknown; values?: unknown } | undefined;
      if (shaped?.type !== undefined && shaped.type !== "effort") continue;
      pushValues(shaped?.values);
    }
  }
  pushValues(raw?.supported_reasoning_efforts);
  if (raw?.reasoning_effort && typeof raw.reasoning_effort === "object") {
    pushValues((raw.reasoning_effort as { values?: unknown }).values);
  }
  return collected.length > 0 ? collected : undefined;
}

export function ingestModelCatalogEntries(
  provider: ProviderId,
  entries: readonly unknown[],
): string[] {
  const models: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const raw = typeof entry === "string" ? entry : (entry as { id?: unknown })?.id;
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const vision = typeof entry === "string" ? undefined : catalogEntryVision(entry);
    const reasoning =
      typeof entry === "string" ? undefined : catalogEntryReasoning(entry);
    const reasoningEfforts =
      typeof entry === "string" ? undefined : catalogEntryReasoningEfforts(entry);
    models.push({
      id,
      ...(vision === undefined ? {} : { vision }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(reasoningEfforts === undefined ? {} : { reasoningEfforts }),
    });
  }
  if (models.length > 0) registerModelCatalog(provider, models);
  return models.map((model) => model.id).sort();
}

export function ingestOpenAiModelCatalog(
  provider: ProviderId,
  payload: unknown,
): string[] {
  const container = payload as { data?: unknown; models?: unknown } | undefined;
  const entries = Array.isArray(payload)
    ? payload
    : Array.isArray(container?.data)
      ? container.data
      : Array.isArray(container?.models)
        ? container.models
        : [];
  return ingestModelCatalogEntries(provider, entries);
}

export async function readJson<T>(response: Response): Promise<T> {
  const text = await readBodyCapped(response, MAX_JSON_RESPONSE_BYTES);
  if (!response.ok) {
    
    let detail = "";
    let extractedMessage = "";
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
      extractedMessage = msg;
    } catch {
      // Non-JSON body — the raw text is surfaced via the full-response rule
      // below, so nothing is lost here.
    }
    // Show the full error received from the request: the extracted
    // `error.message` alone routinely hides the actionable part of a gateway
    // error (upstream detail, codes, validation fields). Append the complete
    // body whenever it carries anything beyond that extracted message.
    const bodyText = text.slice(0, MAX_ERROR_BODY_CHARS);
    if (bodyAddsInformation(bodyText, extractedMessage)) {
      const shown = collapseWhitespace(bodyText);
      const capped =
        shown.length > MAX_ERROR_BODY_IN_MESSAGE_CHARS
          ? `${shown.slice(0, MAX_ERROR_BODY_IN_MESSAGE_CHARS)}…`
          : shown;
      detail = `${detail} — full response: ${capped}`;
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
      bodyText,
      retryAfterSeconds,
    );
  }
  return JSON.parse(text) as T;
}

/** Hard cap on a JSON response body so a misbehaving provider can't OOM us. */
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

/** How much of a provider error body we retain on the ProviderError. */
export const MAX_ERROR_BODY_CHARS = 8_000;
/** How much of that body is embedded in the user-visible error message. */
export const MAX_ERROR_BODY_IN_MESSAGE_CHARS = 2_000;

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * True when the raw response body carries information beyond the message we
 * already extracted from it (extra JSON fields, non-JSON payloads, …). Pure
 * `{"error":{"message": …}}` envelopes are redundant and stay compact.
 */
export function bodyAddsInformation(bodyText: string, extracted: string): boolean {
  const collapsed = collapseWhitespace(bodyText);
  if (!collapsed) return false;
  if (!extracted) return true;
  const normalizedExtracted = collapseWhitespace(extracted);
  // The user-facing text already carries the entire body verbatim.
  if (normalizedExtracted.includes(collapsed)) return false;
  if (!collapsed.includes(normalizedExtracted)) return true;
  const rest = collapsed
    .replace(normalizedExtracted, " ")
    .replace(/\b(errors?|message|msg|detail|details|type|code|status)\b/gi, " ")
    .replace(/[{}\[\]":,]/g, " ")
    .trim();
  return rest.length > 0;
}

async function readBodyCapped(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    
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

/**
 * Mid-stream silence budget.
 *
 * This is deliberately generous because "no bytes" does **not** mean "dead
 * socket" on an OpenAI-compatible endpoint. Most self-hosted runtimes (vLLM /
 * SGLang and the tool-call parsers layered on top of them) buffer an entire
 * `tool_calls` delta before emitting it, so a model writing a large file goes
 * completely silent on the wire for as long as the generation takes. A 90s
 * budget aborted those healthy streams at `firstToken + 90s`, reported the
 * abort as a network failure, and burned three identical retries that each
 * re-generated the same prefix before one happened to finish inside the window.
 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 240_000;

export const THINKING_STREAM_IDLE_TIMEOUT_MS = 600_000;

export const THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS = 600_000;

export function streamIdleBudgets(reasoningEnabled: boolean): {
  idleTimeoutMs: number;
  outputIdleTimeoutMs: number;
} {
  const idleTimeoutMs = reasoningEnabled
    ? THINKING_STREAM_IDLE_TIMEOUT_MS
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  return {
    idleTimeoutMs,
    outputIdleTimeoutMs: Math.round(idleTimeoutMs * 1.5),
  };
}

/**
 * Marker appended to the message of a stall that happened on a **live**
 * connection (bytes/keepalives were still arriving, or output had already
 * started and simply stopped). Such a stall is not a transport failure, so the
 * recovery layer must not classify it as `network` and retry the identical
 * request against the identical route.
 */
export const STREAM_STALL_MARKER = "no model output";



export interface StreamLineReaderOptions {
  signal?: AbortSignal | undefined;
  idleTimeoutMs?: number | undefined;
  maxBytes?: number | undefined;
  /** If provided, called after every read so callers can reset their own
   *  watchdogs (eg the OpenAI-compatible streamer's existing one). */
  onActivity?: (() => void) | undefined;
  outputIdleTimeoutMs?: number | undefined;
  outputProgress?: (() => number) | undefined;
}


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
  const outputIdleTimeoutMs =
    options.outputIdleTimeoutMs ?? Math.round(idleTimeoutMs * 1.5);
  const trackOutput = typeof options.outputProgress === "function";
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  const idleController = new AbortController();
  let idleTimer: NodeJS.Timeout | undefined;
  let outputTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  let firedWatchdog: "transport" | "output" = "transport";
  let lastOutputProgress = trackOutput ? options.outputProgress!() : 0;
  const fireStall = (watchdog: "transport" | "output"): void => {
    if (idleFired) return;
    idleFired = true;
    firedWatchdog = watchdog;
    idleController.abort();
  };
  const clearIdleTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (outputTimer) clearTimeout(outputTimer);
    idleTimer = undefined;
    outputTimer = undefined;
  };
  const armOutputTimer = (): void => {
    if (!trackOutput) return;
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = setTimeout(
      () => fireStall("output"),
      outputIdleTimeoutMs,
    );
  };
  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fireStall("transport"), idleTimeoutMs);
  };
  const noteOutputProgress = (): void => {
    if (!trackOutput) return;
    const current = options.outputProgress!();
    if (current <= lastOutputProgress) return;
    lastOutputProgress = current;
    armOutputTimer();
  };
  const stallError = (): ProviderError =>
    firedWatchdog === "output"
      ? new ProviderError(
          `Provider stream stalled — ${STREAM_STALL_MARKER} for ${Math.round(outputIdleTimeoutMs / 1000)}s.`,
        )
      : new ProviderError(
          `Provider stream stalled — no data for ${Math.round(idleTimeoutMs / 1000)}s.`,
        );
  resetIdleTimer();
  armOutputTimer();
  const onCallerAbort = (): void => idleController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });
  // A caller abort must surface as an abort error, not as a clean
  // end-of-stream — otherwise the partial text is returned as a successful
  // completion and enters history as the model's final answer.
  const callerAbortError = (): Error =>
    (options.signal?.reason as Error | undefined) ??
    new DOMException("The operation was aborted.", "AbortError");
  if (options.signal?.aborted) {
    clearIdleTimers();
    throw callerAbortError();
  }
  // If the idle watchdog already fired, bail before starting the loop.
  if (idleController.signal.aborted) {
    clearIdleTimers();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytesRead = 0;
  
  const cancelReaderOnAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  idleController.signal.addEventListener("abort", cancelReaderOnAbort, {
    once: true,
  });

  try {
    while (true) {
      noteOutputProgress();
      if (idleController.signal.aborted) {
        if (idleFired) throw stallError();
        throw callerAbortError();
      }
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await readWithAbort(reader, idleController.signal);
      } catch (error) {
        if (idleFired) throw stallError();
        throw error;
      }
      const { done, value } = readResult;
      if (done) {
        if (idleFired) throw stallError();
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
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    idleController.signal.removeEventListener("abort", cancelReaderOnAbort);
    
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

/** Result of OpenAI-compatible complete/stream (text + optional native tools). */
export interface OpenAiCompatibleResult {
  text: string;
  toolCalls?: NativeToolCall[] | undefined;
  finishReason?: string | undefined;
  usage?: TokenUsage | undefined;
}

/** Map shared OpenAI-compatible payload → CompletionResult (includes usage). */
export function toCompletionResult(
  provider: ProviderId,
  model: string,
  payload: OpenAiCompatibleResult,
): import("../types.js").CompletionResult {
  return {
    text: payload.text,
    provider,
    model,
    ...(payload.toolCalls?.length ? { toolCalls: payload.toolCalls } : {}),
    ...(payload.finishReason ? { finishReason: payload.finishReason } : {}),
    ...(payload.usage ? { usage: payload.usage } : {}),
  };
}

/**
 * Reassembles SSE `data:` frames.
 *
 * Per the SSE spec a single event's payload may be split across several `data:`
 * lines that the client must concatenate before parsing; each fragment was
 * previously parsed on its own, failed `JSON.parse`, and was dropped as a
 * malformed keepalive — losing content without a trace.
 *
 * A payload is released as soon as it is syntactically complete, so
 * single-line frames behave exactly as before. A blank line (frame terminator)
 * discards an incomplete remainder, and a runaway fragment is dropped rather
 * than corrupting later frames.
 */
export function createSseFrameAssembler(options?: {
  maxBufferedBytes?: number;
}): {
  /** Returns a complete payload, or undefined while still buffering. */
  pushLine: (line: string) => string | undefined;
} {
  const maxBufferedBytes = options?.maxBufferedBytes ?? 1_000_000;
  let buffered = "";
  const complete = (payload: string): boolean => {
    if (payload === "[DONE]") return true;
    try {
      JSON.parse(payload);
      return true;
    } catch {
      return false;
    }
  };
  return {
    pushLine(line: string): string | undefined {
      const trimmed = line.trim();
      if (trimmed === "") {
        // End of event: an incomplete remainder was malformed.
        buffered = "";
        return undefined;
      }
      if (!trimmed.startsWith("data:")) return undefined;
      const chunk = trimmed.slice(5).trim();
      buffered = buffered ? `${buffered}\n${chunk}` : chunk;
      if (complete(buffered)) {
        const payload = buffered;
        buffered = "";
        return payload;
      }
      if (buffered.length > maxBufferedBytes) buffered = "";
      return undefined;
    },
  };
}

export function toOpenAiMessages(
  messages: ChatMessage[],
  supportsVision = true,
): Array<Record<string, unknown>> {
  return toOpenAiToolMessages(messages, (message) => {
    if (
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
            detail: "high",
          },
        });
      }
      return parts;
    }
    return message.content;
  }) as Array<Record<string, unknown>>;
}

export type ReasoningStyle =
  | "openai"
  | "nvidia"
  | "groq"
  | "openrouter"
  | "agentrouter"
  | "modal"
  | "stepfun"
  | "meta"
  | "bynara"
  | "none";


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

export type BynaraReasoningKind =
  | "kimi"
  | "deepseek"
  | "agnes"
  | "stepfun"
  | "none";

export function classifyBynaraModel(model: string): BynaraReasoningKind {
  const m = model.toLowerCase();
  if (/kimi/.test(m)) return "kimi";
  if (/deepseek/.test(m)) return "deepseek";
  if (/agnes/.test(m)) return "agnes";
  if (/stepfun|step-3/.test(m)) return "stepfun";
  return "none";
}

const MODAL_DEFAULT_EFFORTS = ["low", "high", "max"];

const MODAL_EFFORT_PREFERENCE: Record<string, string[]> = {
  minimal: ["minimal", "low", "medium", "high", "max"],
  low: ["low", "minimal", "medium", "high", "max"],
  medium: ["medium", "high", "low", "max"],
  high: ["high", "max", "medium", "low"],
  xhigh: ["xhigh", "max", "high", "medium", "low"],
  max: ["max", "xhigh", "high", "medium", "low"],
};

function pickAdvertisedEffort(
  effort: string,
  advertised: readonly string[],
): string {
  const order = MODAL_EFFORT_PREFERENCE[effort] ?? MODAL_EFFORT_PREFERENCE.medium!;
  return (
    order.find((candidate) => advertised.includes(candidate)) ??
    advertised[advertised.length - 1]!
  );
}

export function buildReasoningPayload(
  reasoning: ReasoningPreference | undefined,
  style: ReasoningStyle,
  model?: string,
  providerId?: ProviderId | undefined,
): Record<string, unknown> {
  if (style === "none") return {};
  const enabled = Boolean(reasoning?.enabled);
  const effort = reasoning?.effort ?? "medium";

  // Map expanded effort levels to the classic low/medium/high subset for
  // providers that only understand the smaller set.
  const clampEffort = (e: string): "low" | "medium" | "high" => {
    if (e === "none" || e === "minimal" || e === "low") return "low";
    if (e === "max" || e === "xhigh" || e === "high") return "high";
    return "medium";
  };

  switch (style) {
    case "meta": {
      const metaEffort = (e: string): string => {
        if (e === "none" || e === "minimal") return "minimal";
        if (e === "max" || e === "xhigh") return "xhigh";
        return e;
      };
      if (!enabled) return { reasoning_effort: "minimal" };
      return { reasoning_effort: metaEffort(effort) };
    }
    case "openai": {
      if (!enabled) {
        return effort === "none" ? { reasoning_effort: "none" } : {};
      }
      // `reasoning_effort` is the Chat Completions knob. The nested
      // `reasoning` object belongs to the Responses API; strict gateways reject
      // unknown top-level fields with a hard 400.
      return { reasoning_effort: clampEffort(effort) };
    }
    case "bynara": {
      const kind = classifyBynaraModel(model ?? "");
      const noThinking = !enabled || effort === "none" || effort === "minimal";
      switch (kind) {
        case "kimi":
          if (noThinking) return { chat_template_kwargs: { thinking: false } };
          if (effort === "high" || effort === "xhigh" || effort === "max") {
            return {
              chat_template_kwargs: { thinking: true },
              reasoning_effort: "high",
            };
          }
          if (effort === "low") {
            return {
              chat_template_kwargs: { thinking: true },
              reasoning_effort: "low",
            };
          }
          return { chat_template_kwargs: { thinking: true } };
        case "deepseek":
        case "agnes":
          if (noThinking) return { reasoning_effort: "none" };
          return { reasoning_effort: clampEffort(effort) };
        case "stepfun":
          if (noThinking) return {};
          return { reasoning_effort: clampEffort(effort) };
        case "none":
          return {};
      }
      return {};
    }
    case "agentrouter": {
      // AgentRouter proxies three families, each with a *different* reasoning
      // contract (verified live against agentrouter.org/v1, 2026-07). We send
      // only the standard top-level knob each one honours — no redundant
      // `reasoning` object (none of the routed models read it).
      const m = (model ?? "").toLowerCase();
      const clamped = clampEffort(effort);
      // OpenAI gpt-5.x / o-series: top-level `reasoning_effort`, and it uniquely
      // supports "minimal". These models can't be fully disabled, so "off"
      // degrades to the cheapest "minimal" rather than the medium default.
      if (/(?:^|\/)gpt-5|(?:^|\/)o[134](?:\b|-)/.test(m)) {
        if (!enabled) return { reasoning_effort: "minimal" };
        const gptEffort =
          effort === "none"
            ? "minimal"
            : effort === "xhigh" || effort === "max"
              ? "high"
              : effort; // minimal | low | medium | high
        return { reasoning_effort: gptEffort };
      }
      // Zhipu GLM thinks by DEFAULT; `reasoning_effort` only modulates depth and
      // cannot turn it off. The one knob that actually disables it on this
      // gateway is `thinking.type=disabled` — so "off" must send that.
      if (/glm/.test(m)) {
        if (!enabled) return { thinking: { type: "disabled" } };
        return { reasoning_effort: clamped };
      }
      // Anthropic Claude: `reasoning_effort` enables extended thinking (the
      // gateway maps it to a thinking budget). Thinking is OFF by default, so
      // "off" simply omits the knob. `buildChatBody` floors max_tokens above the
      // budget so enabling it never trips the gateway's budget precondition.
      if (/claude/.test(m)) {
        if (!enabled) return {};
        return { reasoning_effort: clamped };
      }
      // Unknown model routed by AgentRouter → plain OpenAI-compatible behavior.
      if (!enabled) return {};
      return { reasoning_effort: clamped };
    }
    case "openrouter":
      if (!enabled) return {};
      if (!supportsOpenRouterReasoning(model ?? "")) return {};
      return { reasoning: { enabled: true, effort: clampEffort(effort) } };
    case "modal": {
      const advertised =
        providerId !== undefined && model
          ? modelReasoningEfforts(providerId, model)
          : undefined;
      if (
        !advertised &&
        providerId !== undefined &&
        model &&
        !modelSupportsThinking(providerId, model)
      ) {
        return {};
      }
      if (!enabled || effort === "none") return { reasoning_effort: "none" };
      return {
        reasoning_effort: pickAdvertisedEffort(
          effort,
          advertised ?? MODAL_DEFAULT_EFFORTS,
        ),
      };
    }
    case "stepfun":
      // Step 3.5/3.7 Flash enables a <think> block by default on compatible
      // hosts. Omitting an OpenAI reasoning field does not turn that default
      // off, so compaction would still buy hidden reasoning tokens. vLLM's
      // StepFun template honours this explicit per-request switch.
      return { chat_template_kwargs: { enable_thinking: enabled } };
    case "groq": {
      const m = (model ?? "").toLowerCase();
      if (/qwen\/qwen3-32b/.test(m)) {
        return { reasoning_effort: enabled ? "default" : "none" };
      }
      if (/openai\/gpt-oss-(?:20b|120b)/.test(m)) {
        
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

/**
 * Detects provider errors that mean the model rejected one of our
 * reasoning/thinking knobs (chat_template_kwargs, enable_thinking,
 * clear_thinking, reasoning_effort, reasoning_budget, thinking). NVIDIA NIM and
 * other OpenAI-compatible gateways return a 400/422 for chat templates that do
 * not accept these fields. When this matches, the router strips the reasoning
 * payload and retries so an unsupported option never fails the whole request.
 */
export function isReasoningUnsupportedError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();

  const mentionsReasoningKnob =
    // `\breasoning\b` catches bodies like "Unrecognized request argument
    // supplied: reasoning" so a bare reasoning-field rejection also degrades.
    /chat_template_kwargs|enable_thinking|clear_thinking|reasoning_effort|reasoning_budget|reasoning_content|\breasoning\b|\bthinking\b/.test(
      hay,
    );
  if (!mentionsReasoningKnob) return false;

  // A 4xx that names a reasoning field is a parameter rejection — strip it.
  if (status === 400 || status === 422) return true;

  // Any status: explicit "not supported / unknown / invalid parameter" wording.
  return /not support|unsupported|unknown|unrecognized|not a valid|not allowed|unexpected keyword|does not accept|extra fields not permitted|additional propert|invalid[_ ]?(?:request[_ ]?)?(?:argument|parameter|field)/.test(
    hay,
  );
}

export function isStreamOptionsUnsupportedError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  if (status !== 400 && status !== 422) return false;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();
  return (
    /stream_options|stream options/.test(hay) &&
    /not support|unsupported|unknown|unrecognized|not a valid|not allowed|unexpected keyword|does not accept|extra fields not permitted|additional propert|invalid[_ ]?(?:request[_ ]?)?(?:argument|parameter|field)/.test(
      hay,
    )
  );
}

export function isImageInputUnsupportedError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();

  const mentionsImageInput =
    /image_url|image url|inlinedata|inline_data|\bimages?\b|multimodal|\bvision\b|media_type|image content|content\[\d+\]|content\.\d+|parts\[\d+\]/.test(
      hay,
    );
  if (!mentionsImageInput) return false;
  if (status !== undefined && status !== 400 && status !== 415 && status !== 422) {
    return false;
  }
  return /not support|unsupported|does not accept|cannot process|invalid[_ ]?(?:request[_ ]?)?(?:argument|parameter|field|type|value)?|unknown|unrecognized|not a valid|not allowed|only text|text[- ]only|expected a string|must be a string|additional propert/.test(
    hay,
  );
}

export function stripImagesFromMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.images?.length) return message;
    const { images: _images, ...rest } = message;
    return rest;
  });
}

export function imageCapableMessages(
  provider: ProviderId,
  model: string,
  messages: ChatMessage[],
): ChatMessage[] {
  if (modelAcceptsImages(provider, model)) return messages;
  return stripImagesFromMessages(messages);
}

/**
 * legacy Chat Completions sampling knobs: `max_tokens` must be
 * `max_completion_tokens`, and `temperature`/`top_p` must be omitted or left
 * at their default (non-default values return HTTP 400 "Unsupported
 * parameter"). Matched by model name (not provider) since OpenAI-compatible
 * gateways that pass these model IDs through to the real OpenAI API hit the
 * same restriction.
 * https://help.openai.com/en/articles/5072518 (Chat Completions section).
 */
export function isOpenAiReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    /(?:^|\/)gpt-5(?:\.|-|$)/.test(m) ||
    /(?:^|\/)o[134](?:\.|-|$)/.test(m) ||
    /muse-spark/.test(m)
  );
}

export function buildChatBody(options: {
  model: string;
  /**
   * Canonical provider id. When given, the capability table is consulted so the
   * wire payload and the UI cannot disagree about whether the model has a
   * reasoning knob at all.
   */
  providerId?: ProviderId | undefined;
  messages: ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  stream: boolean;
  /** Set false only after a compatible endpoint rejects `stream_options`. */
  includeStreamUsage?: boolean | undefined;
  reasoning?: ReasoningPreference | undefined;
  reasoningStyle?: ReasoningStyle | undefined;
  supportsVision?: boolean | undefined;
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
}): string {
  // Skip reasoning knobs entirely for models observed to reject them this
  // session (see isReasoningUnsupportedError). This is how thinking degrades
  // gracefully: the request still runs, just without the unsupported option.
  const capabilityDeniesThinking =
    options.providerId !== undefined &&
    Boolean(options.reasoning?.enabled) &&
    !modelSupportsThinking(options.providerId, options.model);
  const reasoning =
    (options.providerId !== undefined &&
      isReasoningUnsupported(options.providerId, options.model)) ||
    capabilityDeniesThinking
      ? {}
      : buildReasoningPayload(
          options.reasoning,
          options.reasoningStyle ?? "none",
          options.model,
          options.providerId,
        );
  
  const reasoningOn = Boolean(options.reasoning?.enabled);
  // Kimchi exposes this model as `minimax-m3`; NVIDIA uses the longer
  // `minimaxai/minimax-m3` ID. Both need the larger default output budget.
  const isMinimaxM3 = /minimax-m3/i.test(options.model);
  const defaultMaxTokens = isMinimaxM3 ? 8_192 : reasoningOn ? 8_192 : 4_096;
  // One declarative sampling policy; explicit caller value wins.
  const sampling = resolveSampling({
    model: options.model,
    reasoningEnabled: reasoningOn,
    requestedTemperature: options.temperature,
  });
  const reasoningModel = isOpenAiReasoningModel(options.model);
  // Claude extended thinking via AgentRouter maps reasoning_effort to an
  // Anthropic `thinking.budget_tokens`, and the gateway (Bedrock) rejects the
  // request with HTTP 400 unless `max_tokens > budget_tokens`. Some upstream
  // nodes enforce this intermittently, so whenever Claude reasoning is enabled
  // we guarantee a ceiling that clears the largest effort budget (32000 was
  // verified live to succeed while staying within Opus's output cap). This is a
  // ceiling, not a forced length — Claude still stops at its natural stop.
  const claudeThinking =
    reasoningOn &&
    options.reasoningStyle === "agentrouter" &&
    /claude/i.test(options.model);
  const effectiveMaxTokens = claudeThinking
    ? Math.max(options.maxTokens ?? defaultMaxTokens, 32_000)
    : (options.maxTokens ?? defaultMaxTokens);
  const body: Record<string, unknown> = {
    model: options.model,
    messages: toOpenAiMessages(options.messages, options.supportsVision),
    stream: options.stream,
    ...(reasoningModel
      ? { max_completion_tokens: effectiveMaxTokens }
      : { max_tokens: effectiveMaxTokens }),
    // gpt-5.x / o1 / o3 / o4 only accept the default temperature (1) and
    // reject any explicit value — omit the field entirely rather than send
    // our 0.2 default and get a 400.
    ...(reasoningModel ? {} : { temperature: sampling.temperature }),
    ...reasoning,
    ...openAiToolBodyFields({
      tools: options.tools,
      toolChoice: options.toolChoice,
      parallelToolCalls: options.parallelToolCalls,
    }),
  };
  if (!reasoningModel && sampling.topP !== undefined) {
    body.top_p = sampling.topP;
  }
  // OpenAI + many OpenAI-compatible gateways attach usage on the final SSE
  // chunk when this is set (non-stream responses always include usage).
  if (options.stream && options.includeStreamUsage !== false) {
    body.stream_options = { include_usage: true };
  }
  return JSON.stringify(body);
}

function sentReasoningEffort(requestBody: string): string | undefined {
  try {
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    if (typeof body.reasoning_effort === "string" && body.reasoning_effort) {
      return body.reasoning_effort;
    }
    const nested = body.reasoning;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const effort = (nested as Record<string, unknown>).effort;
      if (typeof effort === "string" && effort) return effort;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function privateReasoningNote(
  provider: string,
  requestBody: string,
  reasoningTokens: number,
): string {
  const effort = sentReasoningEffort(requestBody);
  const effortText = effort ? ` at ${effort} effort` : "";
  return `Reasoning is private on ${provider}: the model reasoned${effortText} and used ${reasoningTokens.toLocaleString("en-US")} reasoning tokens, but the API returns no reasoning text to display.`;
}

function foldReasoning(
  provider: string,
  requestBody: string,
  text: string,
  reasoning: string | undefined,
  usage: TokenUsage | undefined,
): string {
  if (reasoning && reasoning.trim()) {
    return `${wrapReasoning(reasoning)}${text}`;
  }
  const tokens = usage?.reasoningTokens ?? 0;
  if (tokens > 0) {
    return `${wrapReasoning(privateReasoningNote(provider, requestBody, tokens))}${text}`;
  }
  return text;
}

export async function openAiCompatibleComplete(options: {
  provider: string;
  /** Canonical provider id used for capability lookups. */
  providerId: ProviderId;
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
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
}): Promise<OpenAiCompatibleResult> {
  const supportsVision = modelAcceptsImages(options.providerId, options.model);
  const requestBody = buildChatBody({
    model: options.model,
    providerId: options.providerId,
    messages: options.messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    stream: false,
    reasoning: options.reasoning,
    reasoningStyle: options.reasoningStyle,
    supportsVision,
    tools: options.tools,
    toolChoice: options.toolChoice,
    parallelToolCalls: options.parallelToolCalls,
  });
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      signal: options.signal ?? null,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(options.apiKey
          ? { authorization: `Bearer ${options.apiKey}` }
          : {}),
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
      finish_reason?: string;
      message?: {
        content?: string | null;
        reasoning_content?: string;
        reasoning?: string;
        tool_calls?: Array<{
          id?: string;
          type?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
    usage?: unknown;
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
  const choice = data.choices?.[0];
  const message = choice?.message;
  const toolCalls = parseOpenAiMessageToolCalls(message?.tool_calls);
  const text = message?.content ?? "";
  if (!text && toolCalls.length === 0) {
    throw new ProviderError(
      `${options.provider} returned no completion text (model=${options.model}). The response was empty — try /effort off, raise max_tokens, or pick another model with /model.`,
    );
  }
  // If the API returns reasoning separately, prepend it inside <think>
  // tags so the existing thinking parser can pick it up uniformly.
  const usage = parseOpenAiUsage(data.usage);
  const reasoning = message?.reasoning_content ?? message?.reasoning;
  if (typeof reasoning === "string" && reasoning.trim()) {
    learnModelEmitsReasoning(options.providerId, options.model);
  }
  const full = foldReasoning(
    options.provider,
    requestBody,
    text,
    reasoning,
    usage,
  );
  return {
    text: full,
    ...(toolCalls.length ? { toolCalls } : {}),
    ...(choice?.finish_reason
      ? { finishReason: choice.finish_reason }
      : toolCalls.length
        ? { finishReason: "tool_calls" }
        : {}),
    ...(usage ? { usage } : {}),
  };
}

export async function openAiCompatibleStream(options: {
  provider: string;
  /** Canonical provider id used for capability lookups. */
  providerId: ProviderId;
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
  tools?: ToolDefinition[] | undefined;
  toolChoice?: ToolChoice | undefined;
  parallelToolCalls?: boolean | undefined;
  /** Omit usage stream options for strict OpenAI-compatible gateways. */
  includeStreamUsage?: boolean | undefined;
  /** Early native tool-call name/args progress (P2-3). */
  onToolCallDelta?:
    | ((delta: {
        index: number;
        id?: string;
        name?: string;
        argumentsBytes?: number;
      }) => void)
    | undefined;
  /** Abort a stream that delivers no bytes for this long (mid-stream). */
  idleTimeoutMs?: number | undefined;
  
  initialIdleTimeoutMs?: number | undefined;
  /**
   * Abort a stream that delivers bytes but no model output for this long.
   * Bounds a keepalive-only stream. Defaults to 1.5x the largest byte budget so
   * it always outlasts the transport watchdog.
   */
  outputIdleTimeoutMs?: number | undefined;
}): Promise<OpenAiCompatibleResult> {
  // Combine the caller's abort signal with an idle watchdog so a stuck
  // connection can't wedge the REPL forever. Thinking models get a much
  // longer first-byte budget and a longer mid-stream silence budget —
  // the old 30s default aborted healthy Bynara/OpenRouter streams that
  // were still "thinking" without tokens.
  const reasoningOn = Boolean(options.reasoning?.enabled);
  const idleTimeoutMs =
    options.idleTimeoutMs ??
    (reasoningOn
      ? THINKING_STREAM_IDLE_TIMEOUT_MS
      : DEFAULT_STREAM_IDLE_TIMEOUT_MS);
  const initialIdleTimeoutMs =
    options.initialIdleTimeoutMs ??
    (reasoningOn
      ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS
      : idleTimeoutMs);
  // "No bytes" and "no output" are different failures and need separate
  // budgets. The transport watchdog is re-armed by every read, so an SSE
  // keepalive comment, a `delta:{}` heartbeat, a role-only opening delta, or a
  // multi-line frame still being assembled all count as proof that the
  // connection is healthy. The output watchdog is re-armed only by real model
  // progress, so a stream that keepalives forever without ever producing
  // anything still fails instead of hanging.
  const outputIdleTimeoutMs =
    options.outputIdleTimeoutMs ??
    Math.round(Math.max(idleTimeoutMs, initialIdleTimeoutMs) * 1.5);
  const idleController = new AbortController();
  let transportTimer: NodeJS.Timeout | undefined;
  let outputTimer: NodeJS.Timeout | undefined;
  let idleFired = false;
  let firedWatchdog: "transport" | "output" | undefined;
  /** Budget of whichever watchdog fired, for the error message. */
  let firedBudgetMs = initialIdleTimeoutMs;
  /**
   * Any bytes at all read off the socket, whether or not the frame carried
   * model output. Separates "the route never answered" (retry the request) from
   * "the model was working and went quiet" (a retry replays all of that work).
   */
  let sawTransportActivity = false;
  /** Model-visible progress: content, reasoning, tool-call delta, or usage. */
  let sawStreamProgress = false;
  const fireStall = (
    watchdog: "transport" | "output",
    budgetMs: number,
  ): void => {
    // The two timers can expire in the same event-loop turn. Preserve the first
    // cause so a transport outage is never relabeled by the output watchdog.
    if (idleFired) return;
    idleFired = true;
    firedWatchdog = watchdog;
    firedBudgetMs = budgetMs;
    idleController.abort();
  };
  const armTransportTimer = (budgetMs: number): void => {
    if (transportTimer) clearTimeout(transportTimer);
    transportTimer = setTimeout(
      () => fireStall("transport", budgetMs),
      budgetMs,
    );
  };
  /** Bytes arrived — the connection is alive; re-arm the mid-stream budget. */
  const noteTransportActivity = (): void => {
    sawTransportActivity = true;
    armTransportTimer(idleTimeoutMs);
  };
  const resetIdleTimer = (): void => {
    sawStreamProgress = true;
    noteTransportActivity();
    if (outputTimer) clearTimeout(outputTimer);
    outputTimer = setTimeout(
      () => fireStall("output", outputIdleTimeoutMs),
      outputIdleTimeoutMs,
    );
  };
  armTransportTimer(initialIdleTimeoutMs);
  outputTimer = setTimeout(
    () => fireStall("output", outputIdleTimeoutMs),
    outputIdleTimeoutMs,
  );
  const clearIdleTimers = (): void => {
    if (transportTimer) clearTimeout(transportTimer);
    if (outputTimer) clearTimeout(outputTimer);
    transportTimer = undefined;
    outputTimer = undefined;
  };
  const onCallerAbort = (): void => idleController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onCallerAbort, { once: true });

  const supportsVision = modelAcceptsImages(options.providerId, options.model);
  const requestBody = buildChatBody({
    model: options.model,
    providerId: options.providerId,
    messages: options.messages,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    stream: true,
    includeStreamUsage: options.includeStreamUsage,
    reasoning: options.reasoning,
    reasoningStyle: options.reasoningStyle,
    supportsVision,
    tools: options.tools,
    toolChoice: options.toolChoice,
    parallelToolCalls: options.parallelToolCalls,
  });
  let response: Response;
  try {
    response = await fetch(`${options.baseUrl}/chat/completions`, {
      method: "POST",
      signal: idleController.signal,
      headers: {
        "content-type": "application/json",

        accept: "text/event-stream",
        ...(options.apiKey
          ? { authorization: `Bearer ${options.apiKey}` }
          : {}),
        ...options.headers,
      },
      body: requestBody,
      verbose: process.env.CLAI_VERBOSE === "true",
    } as any);
  } catch (error) {
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    if (idleFired) {
      throw new ProviderError(
        `${options.provider} request timed out before any response (${Math.round(firedBudgetMs / 1000)}s)`,
      );
    }
    throw error;
  }
  if (!response.ok) {
    clearIdleTimers();
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
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    throw new ProviderError(`${options.provider} returned no stream body`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (response.status === 202 || /\bapplication\/json\b/i.test(contentType)) {
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    const data = await readJson<{
      id?: string;
      requestId?: string;
      status?: string;
      usage?: unknown;
      choices?: Array<{
        finish_reason?: string;
        message?: {
          content?: string | null;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: Array<{
            id?: string;
            type?: string;
            function?: { name?: string; arguments?: string };
          }>;
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
    const choice = data.choices?.[0];
    const message = choice?.message;
    const toolCalls = parseOpenAiMessageToolCalls(message?.tool_calls);
    const text = message?.content ?? "";
    const jsonUsage = parseOpenAiUsage(data.usage);
    const reasoning = message?.reasoning_content ?? message?.reasoning;
    const full = foldReasoning(
      options.provider,
      requestBody,
      text,
      reasoning,
      jsonUsage,
    );
    if (full.trim() || toolCalls.length > 0) {
      if (full.trim()) options.onToken(full);
      return {
        text: full,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(choice?.finish_reason
          ? { finishReason: choice.finish_reason }
          : toolCalls.length
            ? { finishReason: "tool_calls" }
            : {}),
        ...(jsonUsage ? { usage: jsonUsage } : {}),
      };
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
  let contentWireSeen = "";
  let reasoningWireSeen = "";
  let inReasoning = false;
  let finishReason: string | undefined;
  let streamUsage: TokenUsage | undefined;
  const toolCallState = new Map<
    number,
    { id?: string; name?: string; arguments: string }
  >();

  const normalizeChannelDelta = (
    token: string,
    seen: string,
  ): { delta: string; seen: string } => {
    if (seen.length >= 64 && token.length >= seen.length && token.startsWith(seen)) {
      return { delta: token.slice(seen.length), seen: token };
    }
    return { delta: token, seen: seen + token };
  };

  const enterReasoning = (): void => {
    if (inReasoning) return;
    inReasoning = true;
    full += REASONING_OPEN;
    options.onToken(REASONING_OPEN);
  };
  const exitReasoning = (): void => {
    if (!inReasoning) return;
    inReasoning = false;
    full += REASONING_CLOSE;
    options.onToken(REASONING_CLOSE);
  };
  const emitPrivateReasoningNote = (hasToolCalls: boolean): void => {
    if (reasoningSeen.trim()) return;
    if (!visible.trim() && !hasToolCalls) return;
    const tokens = streamUsage?.reasoningTokens ?? 0;
    if (tokens <= 0) return;
    const note = privateReasoningNote(options.provider, requestBody, tokens);
    enterReasoning();
    full += note;
    options.onToken(note);
    exitReasoning();
  };

  /**
   * Reasoning-echo suppression.
   *
   * Some gateways/models stream the chain of thought on `reasoning_content` and
   * then replay it verbatim at the start of `content` before the real answer
   * (observed with MiniMax M3 and GLM). Untagged, that replay is
   * indistinguishable from an answer, so it was rendered as the response — the
   * user saw the model's reasoning as its reply even with thinking off.
   *
   * While the leading `content` still matches reasoning we already received, it
   * is kept inside the `<think>` region: never a visible answer, still visible
   * under Ctrl+T, and stripped from history. Only the first
   * ECHO_CONFIRM_CHARS are held back before deciding, so a normal answer is
   * emitted with no perceptible delay.
   */
  const ECHO_CONFIRM_CHARS = 64;
  let echoState: "idle" | "buffering" | "echoing" | "done" = "idle";
  let echoBuffer = "";
  let echoPos = 0;

  const emitVisible = (text: string): void => {
    if (!text) return;
    if (inReasoning) exitReasoning();
    visible += text;
    full += text;
    options.onToken(text);
  };
  /**
   * Route replayed text back into the reasoning region. Deliberately does NOT
   * extend `reasoningSeen`: that string is the comparison baseline, and growing
   * it with the replay would let the echo match itself past the real reasoning.
   */
  const emitReasoningEcho = (text: string): void => {
    if (!text) return;
    enterReasoning();
    full += text;
    options.onToken(text);
  };
  /** Release a still-undecided hold-back as the answer (stream ended early). */
  const flushEchoBuffer = (): void => {
    if (!echoBuffer) return;
    const held = echoBuffer;
    echoBuffer = "";
    echoState = "done";
    emitVisible(held);
  };

  const handleContentToken = (token: string): void => {
    if (echoState === "done") {
      emitVisible(token);
      return;
    }
    if (echoState === "idle") {
      // A replay is only plausible once a meaningful amount of reasoning came
      // through the separate channel.
      if (reasoningSeen.length < ECHO_CONFIRM_CHARS) {
        echoState = "done";
        emitVisible(token);
        return;
      }
      echoState = "buffering";
    }
    if (echoState === "buffering") {
      echoBuffer += token;
      if (reasoningSeen.startsWith(echoBuffer)) {
        if (echoBuffer.length >= ECHO_CONFIRM_CHARS) {
          const confirmed = echoBuffer;
          echoBuffer = "";
          echoPos = confirmed.length;
          echoState = "echoing";
          emitReasoningEcho(confirmed);
        }
        return;
      }
      flushEchoBuffer();
      return;
    }
    // Confirmed replay: consume the matching run, then hand over the answer.
    let matched = 0;
    while (
      matched < token.length &&
      reasoningSeen[echoPos + matched] === token[matched]
    ) {
      matched += 1;
    }
    if (matched > 0) {
      emitReasoningEcho(token.slice(0, matched));
      echoPos += matched;
    }
    if (matched < token.length) {
      echoState = "done";
      emitVisible(token.slice(matched));
    }
  };

  const cleanup = (): void => {
    clearIdleTimers();
    options.signal?.removeEventListener("abort", onCallerAbort);
    idleController.signal.removeEventListener("abort", cancelReaderOnAbort);
  };
  const cancelReaderOnAbort = (): void => {
    reader.cancel().catch(() => undefined);
  };
  idleController.signal.addEventListener("abort", cancelReaderOnAbort, {
    once: true,
  });
  const sseFrames = createSseFrameAssembler();

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
      // Bytes off the wire re-arm the watchdog before anything is parsed.
      // Keepalives and empty deltas are proof of a live connection, so they
      // must not be allowed to age out a stream that is merely quiet.
      if (value && value.byteLength > 0) noteTransportActivity();
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const payload = sseFrames.pushLine(line);
        if (payload === undefined) continue;
        if (payload === "[DONE]") {
          flushEchoBuffer();
          exitReasoning();
          cleanup();
          const toolCalls = finalizeOpenAiToolCalls(toolCallState);
          emitPrivateReasoningNote(toolCalls.length > 0);
          if (!visible.trim() && toolCalls.length === 0) {
            // Thinking models (Kimi/Moonshot via Mantle, etc.) often emit only
            // reasoning, sometimes with tool sentinels inside <think>. Returning
            // the full text lets the agent runner recover tool calls from
            // thinkContent instead of failing the whole stream as an error.
            if (reasoningSeen.trim()) {
              return {
                text: full,
                ...(finishReason ? { finishReason } : { finishReason: "stop" }),
                ...(streamUsage ? { usage: streamUsage } : {}),
              };
            }
            throw new ProviderError(
              `${options.provider} completed without a visible answer.`,
            );
          }
          return {
            text: full,
            ...(toolCalls.length ? { toolCalls } : {}),
            ...(finishReason
              ? { finishReason }
              : toolCalls.length
                ? { finishReason: "tool_calls" }
                : {}),
            ...(streamUsage ? { usage: streamUsage } : {}),
          };
        }
        let parsed: {
          error?: { message?: string; type?: string } | string;
          usage?: unknown;
          choices?: Array<{
            finish_reason?: string;
            delta?: {
              content?: string;
              reasoning_content?: string;
              reasoning?: string;
              role?: string;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                type?: string;
                function?: {
                  name?: string;
                  arguments?: string | Record<string, unknown>;
                };
              }>;
            };
          }>;
        };
        try {
          // Only JSON.parse is allowed to fail silently here. The
          // delta handlers below (tool-arg size guard, UI callbacks) used to be
          // inside this try and had their errors swallowed as "keepalives".
          parsed = JSON.parse(payload) as typeof parsed;
        } catch {
          // Malformed keepalive / comment line.
          continue;
        }
        // Gateways report mid-stream failures as an error frame; that
        // used to be dropped, so an upstream overload looked like a complete
        // (but truncated) answer.
        if (parsed.error) {
          const detail =
            typeof parsed.error === "string"
              ? parsed.error
              : (parsed.error.message ?? parsed.error.type ?? "unknown error");
          throw new ProviderError(
            `${options.provider} stream error: ${detail}`,
            undefined,
            payload.slice(0, 500),
          );
        }
        {
          const chunkUsage = parseOpenAiUsage(parsed.usage);
          if (chunkUsage) streamUsage = chunkUsage;
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          const reasoningToken = delta?.reasoning_content ?? delta?.reasoning;
          const token = delta?.content;
          const toolProgress = delta?.tool_calls?.some((toolCall) =>
            Boolean(
              toolCall.id ||
                toolCall.function?.name ||
                toolCall.function?.arguments,
            ),
          );
          if (
            choice?.finish_reason ||
            chunkUsage ||
            reasoningToken ||
            token ||
            toolProgress
          ) {
            resetIdleTimer();
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          if (reasoningToken) {
            const normalized = normalizeChannelDelta(
              reasoningToken,
              reasoningWireSeen,
            );
            reasoningWireSeen = normalized.seen;
            if (normalized.delta) {
              if (!reasoningSeen) {
                learnModelEmitsReasoning(options.providerId, options.model);
              }
              enterReasoning();
              reasoningSeen += normalized.delta;
              full += normalized.delta;
              options.onToken(normalized.delta);
            }
          }
          if (token) {
            const normalized = normalizeChannelDelta(token, contentWireSeen);
            contentWireSeen = normalized.seen;
            if (normalized.delta) handleContentToken(normalized.delta);
          }
          if (delta?.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              const accInfo = accumulateOpenAiToolCallDelta(toolCallState, tc);
              if (!options.onToolCallDelta) continue;
              const wire = accInfo.name;
              const canonical = wire
                ? (fromWireName(wire) ?? wire)
                : undefined;
              
              const largeArgTick =
                !accInfo.nameBecameKnown &&
                accInfo.argumentsBytes > 0 &&
                accInfo.argumentsBytes % 4096 <
                  (typeof tc.function?.arguments === "string"
                    ? tc.function.arguments.length
                    : 0);
              if (accInfo.nameBecameKnown || largeArgTick) {
                options.onToolCallDelta({
                  index: accInfo.index,
                  ...(accInfo.id !== undefined ? { id: accInfo.id } : {}),
                  ...(canonical !== undefined ? { name: canonical } : {}),
                  argumentsBytes: accInfo.argumentsBytes,
                });
              }
            }
          }
        }
      }
    }
    flushEchoBuffer();
    exitReasoning();
    cleanup();
    const toolCalls = finalizeOpenAiToolCalls(toolCallState);
    emitPrivateReasoningNote(toolCalls.length > 0);
    if (!visible.trim() && toolCalls.length === 0) {
      // See [DONE] branch — hand thinking-only streams to the runner so it can
      // salvage sentinel tool blocks (or nudge) instead of hard-failing.
      if (reasoningSeen.trim()) {
        return {
          text: full,
          ...(finishReason ? { finishReason } : { finishReason: "stop" }),
          ...(streamUsage ? { usage: streamUsage } : {}),
        };
      }
      throw new ProviderError(
        `${options.provider} completed without a visible answer.`,
      );
    }
    return {
      text: full,
      ...(toolCalls.length ? { toolCalls } : {}),
      ...(finishReason
        ? { finishReason }
        : toolCalls.length
          ? { finishReason: "tool_calls" }
          : {}),
      ...(streamUsage ? { usage: streamUsage } : {}),
    };
  } catch (error) {
    if (idleFired) {
      const seconds = Math.round(firedBudgetMs / 1000);
      // Preserve the actual watchdog source. Any byte proves the route admitted
      // the request, but a later byte-silence timeout is still a transport
      // failure; only the output watchdog denotes a live keepalive-only/model
      // stall and receives STREAM_STALL_MARKER.
      if (firedWatchdog === "transport" || !sawTransportActivity) {
        if (!sawTransportActivity) {
          // Keep the established wording: both the router's transparent-retry
          // check and classifyStreamFailure key off this phrase to treat a route
          // that never answered as a retriable transport failure.
          throw new ProviderError(
            `${options.provider} request timed out before any response (${seconds}s) — no data arrived on the connection.`,
          );
        }
        throw new ProviderError(
          `${options.provider} stream transport timeout (${seconds}s) — no data arrived on the connection after it had started.`,
        );
      }
      throw new ProviderError(
        `${options.provider} stream stalled — ${STREAM_STALL_MARKER} for ${seconds}s` +
          (sawStreamProgress
            ? " after it had already started producing output. " +
              "The connection stayed open, so the model was most likely buffering one very large tool call. " +
              "Split large writes into smaller sequential calls, or try a smaller model / disable thinking with /effort off."
            : " — the connection stayed open but the model never produced anything. " +
              "Try another model, or disable thinking with /effort off."),
      );
    }
    throw error;
  } finally {
    // The success paths used to return without releasing the body, so
    // the socket stayed locked until GC — dozens of leaked connections per
    // long agent turn.
    cleanup();
    void reader.cancel().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

export async function openAiCompatiblePing(
  baseUrl: string,
  apiKey: string,
  headers?: Record<string, string> | undefined,
): Promise<void> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      ...headers,
    },
    verbose: process.env.CLAI_VERBOSE === "true",
  } as any);
  await readJson<unknown>(response);
}
