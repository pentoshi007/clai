import type { CompletionRequest, CompletionResult } from "../types.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";
import {
  readJson,
  ingestOpenAiModelCatalog,
  ProviderError,
  createSseFrameAssembler,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  THINKING_STREAM_IDLE_TIMEOUT_MS,
  THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS,
  STREAM_STALL_MARKER,
} from "./http.js";
import { modelAcceptsImages } from "./capabilities.js";
import { resolveSampling } from "./sampling.js";
import { toWireName, fromWireName, parseToolArguments } from "./tool-protocol.js";
import { normalizeTokenUsage } from "./token-usage.js";
import type { TokenUsage } from "./token-usage.js";
import type { NativeToolCall, ToolDefinition } from "../types.js";
import type { ReasoningPreference } from "../types.js";

const baseUrl = "https://api.meta.ai/v1";

const modelCache = new Map<string, { models: string[]; fetchedAt: number }>();
const CACHE_TTL_MS = 60 * 60 * 1000;

function mapMetaEffort(e: string): string {
  if (e === "none" || e === "minimal") return "minimal";
  if (e === "max" || e === "xhigh") return "xhigh";
  if (e === "low") return "low";
  if (e === "high") return "high";
  return "medium";
}

function metaReasoningPayload(reasoning: ReasoningPreference | undefined): Record<string, unknown> {
  const enabled = Boolean(reasoning?.enabled);
  const effort = reasoning?.effort ?? "medium";
  const eff = mapMetaEffort(effort);
  if (!enabled) return { effort: "minimal" };
  let summary: string;
  if (eff === "xhigh" || eff === "high") summary = "detailed";
  else if (eff === "medium") summary = "concise";
  else summary = "auto";
  return { effort: eff, summary };
}

function toResponsesInput(messages: import("../types.js").ChatMessage[], supportsVision: boolean): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    if (m.role === "system") {
      input.push({
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: m.content }],
      });
      continue;
    }
    if (m.role === "user") {
      const blocks: Array<Record<string, unknown>> = [];
      if (m.content) blocks.push({ type: "input_text", text: m.content });
      if (supportsVision && m.images && m.images.length > 0) {
        for (const img of m.images) {
          const mt = (img.mediaType || "").toLowerCase();
          const dataUrl = `data:${img.mediaType};base64,${img.dataBase64}`;
          if (mt === "application/pdf") {
            const filename = img.path ? img.path.split("/").pop() || "document.pdf" : "document.pdf";
            blocks.push({ type: "input_file", filename, file_data: dataUrl });
          } else if (mt.startsWith("video/")) {
            blocks.push({ type: "input_video", video_url: dataUrl });
          } else if (mt.startsWith("audio/")) {
            blocks.push({ type: "input_audio", input_audio: { data: img.dataBase64, format: mt.includes("wav") ? "wav" : "mp3" } } as unknown as Record<string, unknown>);
          } else {
            blocks.push({ type: "input_image", image_url: dataUrl, detail: "high" });
          }
        }
      }
      if (blocks.length === 0) blocks.push({ type: "input_text", text: "" });
      input.push({ type: "message", role: "user", content: blocks });
      continue;
    }
    if (m.role === "assistant") {
      const hasTools = m.toolCalls && m.toolCalls.length > 0;
      if (hasTools) {
        if (m.content && m.content.trim()) {
          input.push({
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: m.content }],
          });
        }
        for (const tc of m.toolCalls!) {
          const wire = toWireName(tc.name);
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: wire,
            arguments: tc.rawArguments ?? JSON.stringify(tc.args ?? {}),
          });
        }
        continue;
      }
      if (m.content !== undefined && m.content !== null) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: m.content }],
        });
      }
      continue;
    }
    if (m.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: m.toolCallId ?? `call_${Date.now()}`,
        output: m.content,
      });
      continue;
    }
  }
  return input;
}

function toResponsesTools(tools: ToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.wireName,
    description: t.description,
    parameters: t.parameters,
  }));
}

function parseMetaUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const u = raw as Record<string, unknown>;
  const inputTokens =
    (u.input_tokens as number | undefined) ??
    (u.prompt_tokens as number | undefined) ??
    (u.inputTokens as number | undefined);
  const outputTokens =
    (u.output_tokens as number | undefined) ??
    (u.completion_tokens as number | undefined) ??
    (u.outputTokens as number | undefined);
  const totalTokens = (u.total_tokens as number | undefined) ?? (u.totalTokens as number | undefined);
  const cached =
    (u.input_tokens_details as Record<string, unknown> | undefined)?.cached_tokens ??
    (u.prompt_tokens_details as Record<string, unknown> | undefined)?.cached_tokens;
  const reasoning =
    (u.output_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens ??
    (u.completion_tokens_details as Record<string, unknown> | undefined)?.reasoning_tokens;
  return normalizeTokenUsage({
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    cachedPromptTokens: typeof cached === "number" ? cached : undefined,
    reasoningTokens: typeof reasoning === "number" ? reasoning : undefined,
    exact: true,
  });
}

function extractReasoningSummary(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const obj = item as Record<string, unknown>;
  const summary = obj.summary;
  if (!Array.isArray(summary)) return "";
  let out = "";
  for (const s of summary) {
    if (s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string") {
      out += (s as Record<string, unknown>).text as string;
    }
  }
  return out;
}

function buildResponsesBody(options: {
  model: string;
  messages: import("../types.js").ChatMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  stream: boolean;
  reasoning?: ReasoningPreference | undefined;
  supportsVision: boolean;
  tools?: ToolDefinition[] | undefined;
  parallelToolCalls?: boolean | undefined;
}): string {
  const reasoning = metaReasoningPayload(options.reasoning);
  const input = toResponsesInput(options.messages, options.supportsVision);
  const tools = toResponsesTools(options.tools);
  const reasoningOn = Boolean(options.reasoning?.enabled);
  const defaultMax = reasoningOn ? 8192 : 4096;
  const effectiveMax = Math.max(16, options.maxTokens ?? defaultMax);
  const sampling = resolveSampling({
    model: options.model,
    reasoningEnabled: reasoningOn,
    requestedTemperature: options.temperature,
  });
  const body: Record<string, unknown> = {
    model: options.model,
    input,
    store: false,
    prompt_cache_key: "clai",
    prompt_cache_retention: "24h",
    include: ["reasoning.encrypted_content"],
    max_output_tokens: effectiveMax,
    temperature: sampling.temperature,
  };
  if (sampling.topP !== undefined) body.top_p = sampling.topP;
  if (reasoning) body.reasoning = reasoning;
  if (options.stream) body.stream = true;
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = options.parallelToolCalls === false ? false : true;
  }
  return JSON.stringify(body);
}

function parseResponsesOutput(data: {
  output?: unknown;
  usage?: unknown;
  id?: string;
}): { text: string; toolCalls: NativeToolCall[]; usage?: TokenUsage | undefined; reasoningSummary: string } {
  const output = Array.isArray(data.output) ? data.output : [];
  let text = "";
  let reasoningSummary = "";
  const toolCalls: NativeToolCall[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    if (obj.type === "message" && obj.role === "assistant") {
      const content = obj.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === "object" && (block as Record<string, unknown>).type === "output_text" && typeof (block as Record<string, unknown>).text === "string") {
            text += (block as Record<string, unknown>).text as string;
          }
        }
      }
    } else if (obj.type === "reasoning") {
      const s = extractReasoningSummary(obj);
      if (s) reasoningSummary += s;
    } else if (obj.type === "function_call") {
      const callId = typeof obj.call_id === "string" ? obj.call_id : typeof obj.id === "string" ? obj.id : `call_${toolCalls.length}`;
      const nameWire = typeof obj.name === "string" ? obj.name : "";
      const canonical = fromWireName(nameWire) ?? nameWire;
      const rawArgs = typeof obj.arguments === "string" ? obj.arguments : JSON.stringify(obj.arguments ?? {});
      let args: Record<string, unknown>;
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
        else args = {};
      } catch {
        args = parseToolArguments(rawArgs);
      }
      toolCalls.push({ id: callId, name: canonical, args, rawArguments: rawArgs });
    }
  }
  const usage = parseMetaUsage(data.usage);
  return { text, toolCalls, usage, reasoningSummary };
}

function foldResponsesReasoning(text: string, reasoningSummary: string, usage?: TokenUsage | undefined, effort?: string | undefined): string {
  if (reasoningSummary && reasoningSummary.trim()) {
    return `<think>${reasoningSummary}</think>${text}`;
  }
  const tokens = usage?.reasoningTokens ?? 0;
  if (tokens > 0) {
    const effortText = effort ? ` at ${effort} effort` : "";
    const note = `Reasoning is private on Meta Model API: the model reasoned${effortText} and used ${tokens.toLocaleString("en-US")} reasoning tokens, but the API returns no reasoning text to display.`;
    return `<think>${note}</think>${text}`;
  }
  return text;
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

export const metaProvider: LlmProvider = {
  id: "meta",
  displayName: "Meta Model API",
  defaultModel: defaultModels.meta,
  envVar: "MODEL_API_KEY",
  validateKey: (key: string) => /^[A-Za-z0-9_.-]{8,}$/.test(key),
  async listModels(auth: ProviderAuth): Promise<string[]> {
    const cacheKey = auth.apiKey ?? "";
    const now = Date.now();
    const cached = modelCache.get(cacheKey);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.models;
    }
    try {
      const headers: Record<string, string> = {};
      if (auth.apiKey) headers["authorization"] = `Bearer ${auth.apiKey}`;
      const response = await fetch(`${baseUrl}/models`, { headers });
      const data = await readJson<{ data?: Array<{ id?: string }> }>(response);
      const models = ingestOpenAiModelCatalog("meta", data);
      if (models.length > 0) {
        modelCache.set(cacheKey, { models, fetchedAt: now });
      }
      return models;
    } catch {
      return [];
    }
  },
  async ping(auth: ProviderAuth): Promise<void> {
    if (!auth.apiKey) throw new Error("Meta Model API key is required");
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${auth.apiKey}` },
    });
    await readJson<unknown>(response);
  },
  async complete(request: CompletionRequest, auth: ProviderAuth): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Meta Model API key is required");
    const model = request.model ?? defaultModels.meta;
    const supportsVision = modelAcceptsImages("meta", model);
    const body = buildResponsesBody({
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      stream: false,
      reasoning: request.thinking,
      supportsVision,
      tools: request.tools,
      parallelToolCalls: request.parallelToolCalls,
    });
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        signal: request.signal ?? null,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${auth.apiKey}`,
        },
        body,
        verbose: process.env.CLAI_VERBOSE === "true",
      } as unknown as RequestInit);
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new ProviderError(`Meta Model API request could not be sent (${msg}). Check connectivity to ${baseUrl}.`);
    }
    let data: { output?: unknown; usage?: unknown; id?: string; error?: unknown };
    try {
      data = await readJson(response);
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new ProviderError(`Meta Model API (model=${model}): ${error.message}`, error.status, error.body, error.retryAfterSeconds);
      }
      throw error;
    }
    const parsed = parseResponsesOutput(data as { output?: unknown; usage?: unknown });
    const usage = parsed.usage ?? parseMetaUsage((data as Record<string, unknown>).usage);
    const effort = (metaReasoningPayload(request.thinking) as Record<string, unknown>)?.effort as string | undefined;
    const full = foldResponsesReasoning(parsed.text, parsed.reasoningSummary, usage, effort);
    if (!full.trim() && parsed.toolCalls.length === 0) {
      throw new ProviderError(`Meta Model API returned no completion text (model=${model}). The response was empty — try /effort off, raise max_tokens, or pick another model with /model.`);
    }
    return {
      text: full,
      provider: "meta",
      model,
      ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      ...(parsed.toolCalls.length ? { finishReason: "tool_calls" } : { finishReason: "stop" }),
      ...(usage ? { usage } : {}),
    };
  },
  async stream(request: CompletionRequest, auth: ProviderAuth, onToken: (token: string) => void): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Meta Model API key is required");
    const model = request.model ?? defaultModels.meta;
    const supportsVision = modelAcceptsImages("meta", model);
    const reasoningOn = Boolean(request.thinking?.enabled);
    const idleTimeoutMs = reasoningOn ? THINKING_STREAM_IDLE_TIMEOUT_MS : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    const initialIdleTimeoutMs = reasoningOn ? THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS : idleTimeoutMs;
    const outputIdleTimeoutMs = Math.round(Math.max(idleTimeoutMs, initialIdleTimeoutMs) * 1.5);
    const idleController = new AbortController();
    let transportTimer: NodeJS.Timeout | undefined;
    let outputTimer: NodeJS.Timeout | undefined;
    let idleFired = false;
    let firedWatchdog: "transport" | "output" | undefined;
    let firedBudgetMs = initialIdleTimeoutMs;
    let sawTransportActivity = false;
    let sawStreamProgress = false;
    const fireStall = (watchdog: "transport" | "output", budgetMs: number): void => {
      if (idleFired) return;
      idleFired = true;
      firedWatchdog = watchdog;
      firedBudgetMs = budgetMs;
      idleController.abort();
    };
    const armTransportTimer = (budgetMs: number): void => {
      if (transportTimer) clearTimeout(transportTimer);
      transportTimer = setTimeout(() => fireStall("transport", budgetMs), budgetMs);
    };
    const noteTransportActivity = (): void => {
      sawTransportActivity = true;
      armTransportTimer(idleTimeoutMs);
    };
    const resetIdleTimer = (): void => {
      sawStreamProgress = true;
      noteTransportActivity();
      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = setTimeout(() => fireStall("output", outputIdleTimeoutMs), outputIdleTimeoutMs);
    };
    armTransportTimer(initialIdleTimeoutMs);
    outputTimer = setTimeout(() => fireStall("output", outputIdleTimeoutMs), outputIdleTimeoutMs);
    const clearIdleTimers = (): void => {
      if (transportTimer) clearTimeout(transportTimer);
      if (outputTimer) clearTimeout(outputTimer);
      transportTimer = undefined;
      outputTimer = undefined;
    };
    const onCallerAbort = (): void => idleController.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });

    const body = buildResponsesBody({
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      stream: true,
      reasoning: request.thinking,
      supportsVision,
      tools: request.tools,
      parallelToolCalls: request.parallelToolCalls,
    });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        signal: idleController.signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          authorization: `Bearer ${auth.apiKey}`,
        },
        body,
        verbose: process.env.CLAI_VERBOSE === "true",
      } as unknown as RequestInit);
    } catch (error) {
      clearIdleTimers();
      request.signal?.removeEventListener("abort", onCallerAbort);
      if (idleFired) {
        throw new ProviderError(`Meta Model API request timed out before any response (${Math.round(firedBudgetMs / 1000)}s)`);
      }
      throw error;
    }
    if (!response.ok) {
      clearIdleTimers();
      request.signal?.removeEventListener("abort", onCallerAbort);
      try {
        await readJson<unknown>(response);
      } catch (error) {
        if (error instanceof ProviderError) {
          throw new ProviderError(`Meta Model API (model=${model}): ${error.message}`, error.status, error.body, error.retryAfterSeconds);
        }
        throw error;
      }
    }
    if (!response.body) {
      clearIdleTimers();
      request.signal?.removeEventListener("abort", onCallerAbort);
      throw new ProviderError(`Meta Model API returned no stream body`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 202 || /\bapplication\/json\b/i.test(contentType)) {
      clearIdleTimers();
      request.signal?.removeEventListener("abort", onCallerAbort);
      const data = await readJson<{
        output?: unknown;
        usage?: unknown;
        id?: string;
        requestId?: string;
      }>(response);
      if (response.status === 202) {
        const requestId = (data as Record<string, unknown>).requestId ?? (data as Record<string, unknown>).id;
        throw new ProviderError(
          `Meta Model API returned a pending async response${requestId ? ` (${requestId})` : ""}; streaming did not start.`,
          response.status,
          JSON.stringify(data).slice(0, 1_000),
        );
      }
      const parsed = parseResponsesOutput(data);
      const usageTmp = parsed.usage ?? parseMetaUsage((data as Record<string, unknown>).usage);
      const effortTmp = (metaReasoningPayload(request.thinking) as Record<string, unknown>)?.effort as string | undefined;
      const full = foldResponsesReasoning(parsed.text, parsed.reasoningSummary, usageTmp, effortTmp);
      if (full.trim() || parsed.toolCalls.length > 0) {
        if (full.trim()) onToken(full);
        return {
          text: full,
          provider: "meta",
          model,
          ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
          ...(parsed.toolCalls.length ? { finishReason: "tool_calls" } : { finishReason: "stop" }),
          ...(usageTmp ? { usage: usageTmp } : {}),
        };
      }
      throw new ProviderError(`Meta Model API returned JSON instead of an SSE stream, but no completion text was present.`, response.status, JSON.stringify(data).slice(0, 1_000));
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let full = "";
    let visible = "";
    let reasoningSeen = "";
    let inReasoning = false;
    let finishReason: string | undefined;
    let streamUsage: TokenUsage | undefined;
    const toolCallState = new Map<string, { id?: string; name?: string; arguments: string; callId?: string }>();
    const outputIndexToItemId = new Map<number, string>();
    let responseId: string | undefined;

    const enterReasoning = (): void => {
      if (inReasoning) return;
      inReasoning = true;
      full += "<think>";
      onToken("<think>");
    };
    const exitReasoning = (): void => {
      if (!inReasoning) return;
      inReasoning = false;
      full += "</think>";
      onToken("</think>");
    };
    const emitVisible = (text: string): void => {
      if (!text) return;
      if (inReasoning) exitReasoning();
      visible += text;
      full += text;
      onToken(text);
    };
    const emitReasoningDelta = (text: string): void => {
      if (!text) return;
      enterReasoning();
      reasoningSeen += text;
      full += text;
      onToken(text);
    };
    const cleanup = (): void => {
      clearIdleTimers();
      request.signal?.removeEventListener("abort", onCallerAbort);
      idleController.signal.removeEventListener("abort", cancelReaderOnAbort);
    };
    const cancelReaderOnAbort = (): void => {
      reader.cancel().catch(() => undefined);
    };
    idleController.signal.addEventListener("abort", cancelReaderOnAbort, { once: true });
    const sseFrames = createSseFrameAssembler();

    try {
      while (true) {
        request.signal?.throwIfAborted();
        if (idleController.signal.aborted) throw new Error("Stream aborted");
        const { done, value } = await readWithAbort(reader, idleController.signal);
        request.signal?.throwIfAborted();
        if (idleController.signal.aborted) throw new Error("Stream aborted");
        if (done) break;
        if (value && value.byteLength > 0) noteTransportActivity();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const payload = sseFrames.pushLine(line);
          if (payload === undefined) continue;
          if (payload === "[DONE]") {
            if (!reasoningSeen.trim() && streamUsage?.reasoningTokens && streamUsage.reasoningTokens > 0 && (visible.trim() || toolCallState.size > 0)) {
              const effort = (metaReasoningPayload(request.thinking) as Record<string, unknown>)?.effort as string | undefined;
              const effortText = effort ? ` at ${effort} effort` : "";
              const note = `Reasoning is private on Meta Model API: the model reasoned${effortText} and used ${streamUsage.reasoningTokens.toLocaleString("en-US")} reasoning tokens, but the API returns no reasoning text to display.`;
              emitReasoningDelta(note);
              exitReasoning();
            } else {
              exitReasoning();
            }
            cleanup();
            const toolCalls: NativeToolCall[] = [];
            for (const [, state] of toolCallState) {
              if (!state.name) continue;
              const canonical = state.name ? fromWireName(state.name) ?? state.name : state.name ?? "";
              const raw = state.arguments;
              let args: Record<string, unknown>;
              try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
                else args = {};
              } catch {
                args = parseToolArguments(raw);
              }
              toolCalls.push({ id: state.callId ?? state.id ?? `call_${toolCalls.length}`, name: canonical, args, rawArguments: raw });
            }
            if (!visible.trim() && toolCalls.length === 0) {
              if (reasoningSeen.trim()) {
                return { text: full, provider: "meta", model, finishReason: finishReason ?? "stop", ...(streamUsage ? { usage: streamUsage } : {}) };
              }
              throw new ProviderError(`Meta Model API completed without a visible answer.`);
            }
            return {
              text: full,
              provider: "meta",
              model,
              ...(toolCalls.length ? { toolCalls } : {}),
              ...(finishReason ? { finishReason } : toolCalls.length ? { finishReason: "tool_calls" } : {}),
              ...(streamUsage ? { usage: streamUsage } : {}),
            };
          }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (parsed.error) {
            const detail =
              typeof parsed.error === "string"
                ? parsed.error
                : ((parsed.error as Record<string, unknown>).message as string | undefined) ?? ((parsed.error as Record<string, unknown>).type as string | undefined) ?? "unknown error";
            throw new ProviderError(`Meta Model API stream error: ${detail}`, undefined, payload.slice(0, 500));
          }
          const type = parsed.type as string | undefined;
          if (type === "response.created" || type === "response.in_progress") {
            const resp = (parsed.response ?? parsed) as Record<string, unknown>;
            if (typeof resp.id === "string") responseId = resp.id;
            continue;
          }
          if (type === "response.output_item.added") {
            const item = parsed.item as Record<string, unknown> | undefined;
            if (!item) continue;
            const outputIndex = typeof parsed.output_index === "number" ? parsed.output_index : undefined;
            const itemId = typeof item.id === "string" ? item.id : typeof parsed.item_id === "string" ? parsed.item_id : undefined;
            if (outputIndex !== undefined && itemId) outputIndexToItemId.set(outputIndex, itemId);
            if (item.type === "function_call") {
              const id = typeof item.id === "string" ? item.id : typeof item.call_id === "string" ? item.call_id : itemId ?? `call_${toolCallState.size}`;
              const callId = typeof item.call_id === "string" ? item.call_id : id;
              const name = typeof item.name === "string" ? item.name : "";
              const args = typeof item.arguments === "string" ? item.arguments : "";
              toolCallState.set(id, { id, callId, name, arguments: args });
              resetIdleTimer();
              if (request.onToolCallDelta) {
                const canonical = name ? fromWireName(name) ?? name : undefined;
                request.onToolCallDelta({ index: toolCallState.size - 1, ...(callId ? { id: callId } : {}), ...(canonical ? { name: canonical } : {}), argumentsBytes: args.length });
              }
            } else if (item.type === "reasoning") {
              const s = extractReasoningSummary(item);
              if (s) {
                resetIdleTimer();
                emitReasoningDelta(s);
              }
            } else if (item.type === "message") {
              resetIdleTimer();
            }
            continue;
          }
          if (type === "response.output_item.done") {
            const item = parsed.item as Record<string, unknown> | undefined;
            if (item?.type === "function_call") {
              const id = typeof item.id === "string" ? item.id : typeof (parsed as Record<string, unknown>).item_id === "string" ? (parsed as Record<string, unknown>).item_id as string : undefined;
              if (id && toolCallState.has(id)) {
                const state = toolCallState.get(id)!;
                if (typeof item.arguments === "string" && item.arguments.length > state.arguments.length) state.arguments = item.arguments as string;
                if (typeof item.name === "string" && !state.name) state.name = item.name as string;
                if (typeof item.call_id === "string" && !state.callId) state.callId = item.call_id as string;
              }
              resetIdleTimer();
            }
            if (item && typeof item.status === "string") finishReason = item.status as string;
            continue;
          }
          if (type === "response.content_part.added" || type === "response.content_part.done") {
            continue;
          }
          if (type === "response.output_text.delta") {
            const delta = typeof parsed.delta === "string" ? parsed.delta : "";
            if (delta) {
              resetIdleTimer();
              emitVisible(delta);
            }
            continue;
          }
          if (type === "response.reasoning_summary_text.delta") {
            const delta = typeof parsed.delta === "string" ? parsed.delta : "";
            if (delta) {
              resetIdleTimer();
              emitReasoningDelta(delta);
            }
            continue;
          }
          if (type === "response.reasoning_summary_text.done") {
            const textVal = typeof parsed.text === "string" ? parsed.text : "";
            if (textVal && !reasoningSeen.includes(textVal)) {
              const remaining = textVal.slice(reasoningSeen.length);
              if (remaining) {
                resetIdleTimer();
                emitReasoningDelta(remaining);
              }
            }
            exitReasoning();
            continue;
          }
          if (type === "response.function_call_arguments.delta") {
            const delta = typeof parsed.delta === "string" ? parsed.delta : "";
            const itemId = typeof parsed.item_id === "string" ? parsed.item_id : typeof parsed.itemId === "string" ? parsed.itemId : undefined;
            let targetId = itemId;
            if (!targetId && typeof parsed.output_index === "number") targetId = outputIndexToItemId.get(parsed.output_index as number);
            if (targetId) {
              const state = toolCallState.get(targetId);
              if (state) {
                state.arguments += delta;
                resetIdleTimer();
                if (request.onToolCallDelta) {
                  const canonical = state.name ? fromWireName(state.name) ?? state.name : undefined;
                  request.onToolCallDelta({ index: Array.from(toolCallState.keys()).indexOf(targetId), ...(state.callId ? { id: state.callId } : {}), ...(canonical ? { name: canonical } : {}), argumentsBytes: state.arguments.length });
                }
              } else {
                toolCallState.set(targetId, { id: targetId, callId: targetId, name: "", arguments: delta });
                resetIdleTimer();
              }
            } else if (delta) {
              const anyKey = Array.from(toolCallState.keys()).pop();
              if (anyKey) {
                const state = toolCallState.get(anyKey)!;
                state.arguments += delta;
                resetIdleTimer();
              }
            }
            continue;
          }
          if (type === "response.function_call_arguments.done") {
            const args = typeof parsed.arguments === "string" ? parsed.arguments : typeof parsed.argument === "string" ? parsed.argument : "";
            const itemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
            let targetId = itemId;
            if (!targetId && typeof parsed.output_index === "number") targetId = outputIndexToItemId.get(parsed.output_index as number);
            if (targetId && toolCallState.has(targetId) && args) {
              toolCallState.get(targetId)!.arguments = args;
            } else if (args && toolCallState.size > 0) {
              const lastKey = Array.from(toolCallState.keys()).pop()!;
              if (!toolCallState.get(lastKey)!.arguments) toolCallState.get(lastKey)!.arguments = args;
            }
            resetIdleTimer();
            continue;
          }
          if (type === "response.completed") {
            const resp = (parsed.response ?? parsed) as Record<string, unknown>;
            if (resp.usage) {
              const u = parseMetaUsage(resp.usage);
              if (u) streamUsage = u;
            }
            if (typeof resp.status === "string") finishReason = resp.status as string;
            if (Array.isArray(resp.output)) {
              const out = parseResponsesOutput(resp as { output?: unknown; usage?: unknown });
              if (out.reasoningSummary && !reasoningSeen.trim()) {
                emitReasoningDelta(out.reasoningSummary);
                exitReasoning();
              }
              if (out.text && !visible.trim()) {
                emitVisible(out.text);
              }
              for (const tc of out.toolCalls) {
                const exists = Array.from(toolCallState.values()).some((s) => s.callId === tc.id);
                if (!exists) {
                  const id = tc.id;
                  toolCallState.set(id, { id, callId: tc.id, name: toWireName(tc.name), arguments: tc.rawArguments ?? JSON.stringify(tc.args) });
                }
              }
            }
            continue;
          }
          if (type === "response.failed" || type === "response.incomplete") {
            const resp = (parsed.response ?? parsed) as Record<string, unknown>;
            const err = resp.error as Record<string, unknown> | undefined;
            const detail = err?.message ?? err?.code ?? type;
            throw new ProviderError(`Meta Model API stream error: ${String(detail)}`, undefined, payload.slice(0, 500));
          }
          const usageField = parsed.usage;
          if (usageField) {
            const u = parseMetaUsage(usageField);
            if (u) {
              streamUsage = u;
              resetIdleTimer();
            }
          }
          const choice = (parsed as Record<string, unknown>).choices as unknown;
          if (choice) {
            const chunkUsage = parseMetaUsage((parsed as Record<string, unknown>).usage);
            if (chunkUsage) streamUsage = chunkUsage;
          }
        }
      }
      if (!reasoningSeen.trim() && streamUsage?.reasoningTokens && streamUsage.reasoningTokens > 0 && (visible.trim() || toolCallState.size > 0)) {
        const effort = (metaReasoningPayload(request.thinking) as Record<string, unknown>)?.effort as string | undefined;
        const effortText = effort ? ` at ${effort} effort` : "";
        const note = `Reasoning is private on Meta Model API: the model reasoned${effortText} and used ${streamUsage.reasoningTokens.toLocaleString("en-US")} reasoning tokens, but the API returns no reasoning text to display.`;
        if (!inReasoning) {
          full += "<think>";
          visible = full;
          onToken("<think>");
        }
        full += note;
        reasoningSeen += note;
        onToken(note);
        full += "</think>";
        onToken("</think>");
        inReasoning = false;
      } else {
        exitReasoning();
      }
      cleanup();
      const toolCalls: NativeToolCall[] = [];
      for (const [, state] of toolCallState) {
        if (!state.name && !state.arguments) continue;
        const name = state.name || "";
        const canonical = name ? fromWireName(name) ?? name : "";
        if (!canonical) continue;
        const raw = state.arguments;
        let args: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed as Record<string, unknown>;
          else args = {};
        } catch {
          args = parseToolArguments(raw);
        }
        toolCalls.push({ id: state.callId ?? state.id ?? `call_${toolCalls.length}`, name: canonical, args, rawArguments: raw });
      }
      if (!visible.trim() && toolCalls.length === 0) {
        if (reasoningSeen.trim()) {
          return { text: full, provider: "meta", model, finishReason: finishReason ?? "stop", ...(streamUsage ? { usage: streamUsage } : {}) };
        }
        throw new ProviderError(`Meta Model API completed without a visible answer.`);
      }
      return {
        text: full,
        provider: "meta",
        model,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(finishReason ? { finishReason } : toolCalls.length ? { finishReason: "tool_calls" } : {}),
        ...(streamUsage ? { usage: streamUsage } : {}),
      };
    } catch (error) {
      if (idleFired) {
        const seconds = Math.round(firedBudgetMs / 1000);
        if (firedWatchdog === "transport" || !sawTransportActivity) {
          if (!sawTransportActivity) {
            throw new ProviderError(`Meta Model API request timed out before any response (${seconds}s) — no data arrived on the connection.`);
          }
          throw new ProviderError(`Meta Model API stream transport timeout (${seconds}s) — no data arrived on the connection after it had started.`);
        }
        throw new ProviderError(
          `Meta Model API stream stalled — ${STREAM_STALL_MARKER} for ${seconds}s` +
            (sawStreamProgress
              ? " after it had already started producing output. The connection stayed open, so the model was most likely buffering one very large tool call. Split large writes into smaller sequential calls, or try a smaller model / disable thinking with /effort off."
              : " — the connection stayed open but the model never produced anything. Try another model, or disable thinking with /effort off."),
        );
      }
      throw error;
    } finally {
      cleanup();
      void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {}
    }
  },
};
