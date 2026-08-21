import type {
  CompletionRequest,
  CompletionResult,
  ReasoningArtifactReplayObserver,
  ReasoningArtifactReplayTarget,
} from "../types.js";
import { defaultModels, type LlmProvider, type ProviderAuth } from "./provider.js";
import { cacheAffinityKey } from "./cache-affinity.js";
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
import {
  completeGenerationAttempt,
  generationFetch,
  runGenerationAttempt,
} from "./operation-usage.js";
import { isOperationPolicyError } from "./operation-ledger.js";
import { toWireName, fromWireName, parseToolArguments } from "./tool-protocol.js";
import {
  normalizeTokenUsage,
  withReasoningObservation,
} from "./token-usage.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
  reasoningArtifactItems,
  reasoningArtifactsForMessage,
  selectReasoningArtifactsForReplay,
} from "./reasoning-artifacts.js";
import { compileRequestPlan } from "./request-plan.js";
import {
  emitStreamReasoningArtifacts,
  emitStreamReasoningDelta,
} from "./stream-events.js";
import {
  META_STREAM_TERMINAL,
  requireTerminalProof,
} from "./stream-terminal.js";
import type { StreamTerminalProof } from "./provider-profile.js";
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

interface MetaReasoningReplayOptions {
  readonly target: ReasoningArtifactReplayTarget;
  readonly observe?: ReasoningArtifactReplayObserver | undefined;
}

function metaReplayArtifacts(
  message: import("../types.js").ChatMessage,
  replay: MetaReasoningReplayOptions,
): Array<{
  items: Array<Record<string, unknown>>;
  toolCallIndex?: number | undefined;
}> {
  return selectReasoningArtifactsForReplay({
    artifacts: reasoningArtifactsForMessage(message),
    target: replay.target,
    context: { hasToolCalls: Boolean(message.toolCalls?.length) },
    observe: replay.observe,
  })
    .filter((artifact) => artifact.kind === "encrypted")
    .sort((left, right) => left.position.sequence - right.position.sequence)
    .map((artifact) => {
      const byId = artifact.position.toolCallId
        ? message.toolCalls?.findIndex(
            (toolCall) => toolCall.id === artifact.position.toolCallId,
          )
        : undefined;
      const toolCallIndex =
        artifact.position.toolCallIndex ??
        (byId !== undefined && byId >= 0 ? byId : undefined);
      return {
        items: reasoningArtifactItems(artifact),
        ...(toolCallIndex === undefined ? {} : { toolCallIndex }),
      };
    });
}

function appendMetaReplayItems(
  input: Array<Record<string, unknown>>,
  entries: readonly { items: Array<Record<string, unknown>> }[],
): void {
  for (const entry of entries) input.push(...entry.items);
}

function toResponsesInput(
  messages: import("../types.js").ChatMessage[],
  supportsVision: boolean,
  replay: MetaReasoningReplayOptions,
): Array<Record<string, unknown>> {
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
      const replayArtifacts = metaReplayArtifacts(m, replay);
      const leadingArtifacts = replayArtifacts.filter(
        (artifact) => artifact.toolCallIndex === undefined,
      );
      const artifactsByTool = new Map<number, typeof replayArtifacts>();
      for (const artifact of replayArtifacts) {
        if (artifact.toolCallIndex === undefined) continue;
        const current = artifactsByTool.get(artifact.toolCallIndex) ?? [];
        current.push(artifact);
        artifactsByTool.set(artifact.toolCallIndex, current);
      }
      const hasTools = m.toolCalls && m.toolCalls.length > 0;
      if (hasTools) {
        appendMetaReplayItems(input, leadingArtifacts);
        if (m.content && m.content.trim()) {
          input.push({
            type: "message",
            role: "assistant",
            phase: "commentary",
            content: [{ type: "output_text", text: m.content }],
          });
        }
        for (const [toolCallIndex, tc] of m.toolCalls!.entries()) {
          appendMetaReplayItems(
            input,
            artifactsByTool.get(toolCallIndex) ?? [],
          );
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
      appendMetaReplayItems(input, replayArtifacts);
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

export function parseMetaUsage(raw: unknown): TokenUsage | undefined {
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
  const totalTokens =
    (u.total_tokens as number | undefined) ??
    (u.totalTokens as number | undefined);
  const inputDetails = u.input_tokens_details as Record<string, unknown> | undefined;
  const promptDetails = u.prompt_tokens_details as Record<string, unknown> | undefined;
  const outputDetails = u.output_tokens_details as Record<string, unknown> | undefined;
  const completionDetails =
    u.completion_tokens_details as Record<string, unknown> | undefined;
  const cached = inputDetails?.cached_tokens ?? promptDetails?.cached_tokens;
  const cacheCreation =
    inputDetails?.cache_creation_tokens ??
    promptDetails?.cache_creation_tokens ??
    u.cache_creation_input_tokens;
  const uncached =
    inputDetails?.uncached_tokens ??
    promptDetails?.uncached_tokens ??
    u.prompt_cache_miss_tokens;
  const reasoning =
    outputDetails?.reasoning_tokens ?? completionDetails?.reasoning_tokens;
  return normalizeTokenUsage({
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens,
    cachedPromptTokens: typeof cached === "number" ? cached : undefined,
    cacheCreationTokens:
      typeof cacheCreation === "number" ? cacheCreation : undefined,
    uncachedPromptTokens: typeof uncached === "number" ? uncached : undefined,
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
  tools?: ToolDefinition[] | undefined;
  parallelToolCalls?: boolean | undefined;
  purpose?: import("../types.js").CompletionRequestPurpose | undefined;
  reasoningArtifactReplayObserver?: ReasoningArtifactReplayObserver | undefined;
}): string {
  const plan = compileRequestPlan({
    provider: "meta",
    model: options.model,
    messages: options.messages,
    stream: options.stream,
    endpoint: baseUrl,
    reasoning: options.reasoning,
    tools: options.tools,
    parallelToolCalls: options.parallelToolCalls,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
  });
  const reasoning = metaReasoningPayload(plan.controls.reasoning);
  const input = toResponsesInput([...plan.timeline.messages], plan.images.visionAccepted, {
    target: plan.replay.target,
    observe: options.reasoningArtifactReplayObserver,
  });
  const tools = toResponsesTools(
    plan.tools.definitions.length ? [...plan.tools.definitions] : undefined,
  );
  const reasoningOn = Boolean(plan.controls.reasoning?.enabled);
  const defaultMax = reasoningOn ? 8192 : 4096;
  const effectiveMax = Math.max(16, plan.controls.requestedMaxTokens ?? defaultMax);
  const body: Record<string, unknown> = {
    model: options.model,
    input,
    store: false,
    prompt_cache_key: `${options.purpose === "auxiliary" ? "aux-" : ""}${cacheAffinityKey("meta", options.model, options.messages)}`,
    prompt_cache_retention: "24h",
    include: ["reasoning.encrypted_content"],
    max_output_tokens: effectiveMax,
    temperature: plan.controls.temperature,
  };
  if (plan.controls.topP !== undefined) body.top_p = plan.controls.topP;
  if (reasoning) body.reasoning = reasoning;
  if (options.stream) body.stream = true;
  if (tools) {
    body.tools = tools;
    body.tool_choice = "auto";
    body.parallel_tool_calls = options.parallelToolCalls === false ? false : true;
  }
  return JSON.stringify(body);
}

const META_MAX_OUTPUT_TOKENS_CAP = 65536;
const MAX_INCOMPLETE_BUDGET_RETRIES = 2;
const incompleteBudgetRetries = new WeakMap<CompletionRequest, number>();

function incompleteBudgetRetry(request: CompletionRequest, reasoningOn: boolean): CompletionRequest | undefined {
  const used = incompleteBudgetRetries.get(request) ?? 0;
  const currentBudget = Math.max(16, request.maxTokens ?? (reasoningOn ? 8192 : 4096));
  const nextBudget = Math.min(currentBudget * 2, META_MAX_OUTPUT_TOKENS_CAP);
  if (used >= MAX_INCOMPLETE_BUDGET_RETRIES || nextBudget <= currentBudget) return undefined;
  const retryRequest: CompletionRequest = { ...request, maxTokens: nextBudget };
  incompleteBudgetRetries.set(retryRequest, used + 1);
  return retryRequest;
}

function budgetExhaustedError(request: CompletionRequest, reasoningOn: boolean, payload: string): ProviderError {
  const currentBudget = Math.max(16, request.maxTokens ?? (reasoningOn ? 8192 : 4096));
  const effort = (metaReasoningPayload(request.thinking) as Record<string, unknown>)?.effort as string | undefined;
  const retried = (incompleteBudgetRetries.get(request) ?? 0) > 0;
  return new ProviderError(
    `Meta Model API spent the entire output budget (${currentBudget} tokens${effort ? `, mostly on reasoning at ${effort} effort` : ""}) without producing an answer${retried ? ", even after raising max_output_tokens" : ""}. Lower the effort with /effort high or raise max_tokens.`,
    undefined,
    payload.slice(0, 1000),
  );
}

interface MetaReasoningItemPosition {
  readonly sequence: number;
  readonly toolCallIndex?: number | undefined;
}

function parseResponsesOutput(data: {
  output?: unknown;
  usage?: unknown;
  id?: string;
}): {
  text: string;
  toolCalls: NativeToolCall[];
  usage?: TokenUsage | undefined;
  reasoningSummary: string;
  reasoningItems: Array<Record<string, unknown>>;
  reasoningItemPositions: MetaReasoningItemPosition[];
} {
  const output = Array.isArray(data.output) ? data.output : [];
  let text = "";
  let reasoningSummary = "";
  const toolCalls: NativeToolCall[] = [];
  const reasoningItems: Array<Record<string, unknown>> = [];
  const reasoningItemSequences: number[] = [];
  const toolCallSequences: Array<{ sequence: number; toolCallIndex: number }> = [];
  for (const [sequence, item] of output.entries()) {
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
      if (typeof obj.encrypted_content === "string" && obj.encrypted_content) {
        reasoningItems.push({ ...obj });
        reasoningItemSequences.push(sequence);
      }
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
      const toolCallIndex = toolCalls.length;
      toolCalls.push({ id: callId, name: canonical, args, rawArguments: rawArgs });
      toolCallSequences.push({ sequence, toolCallIndex });
    }
  }
  const reasoningItemPositions = reasoningItemSequences.map((sequence) => {
    const followingTool = toolCallSequences.find(
      (toolCall) => toolCall.sequence > sequence,
    );
    return followingTool
      ? { sequence, toolCallIndex: followingTool.toolCallIndex }
      : { sequence };
  });
  const usage = parseMetaUsage(data.usage);
  return {
    text,
    toolCalls,
    usage,
    reasoningSummary,
    reasoningItems,
    reasoningItemPositions,
  };
}

function metaReasoningArtifacts(
  model: string,
  items: readonly Record<string, unknown>[],
  positions: readonly MetaReasoningItemPosition[],
) {
  const provenance = createReasoningArtifactProvenance({
    provider: "meta",
    model,
    dialect: "meta-responses",
    endpoint: baseUrl,
  });
  const artifacts = items.map((item, index) => {
    const position = positions[index] ?? { sequence: index };
    const replayable = position.toolCallIndex !== undefined;
    return createReasoningArtifact({
      kind: "encrypted",
      raw: item,
      provenance,
      replay: replayable
        ? { scope: "tool-turn", persistence: "tool-turn" }
        : { scope: "none", persistence: "never" },
      position: {
        sequence: position.sequence,
        placement: replayable ? "before-tool-call" : "assistant",
        ...(replayable ? { toolCallIndex: position.toolCallIndex } : {}),
      },
    });
  });
  return artifacts.length ? artifacts : undefined;
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
  reasoningStyle: "meta",
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
    return runGenerationAttempt(
      request,
      {
        provider: "meta",
        model,
        mode: "complete",
        reason: request.attemptReason ?? "initial",
      },
      async () => {
    const body = buildResponsesBody({
      model,
      messages: request.messages,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      stream: false,
      reasoning: request.thinking,
      tools: request.tools,
      parallelToolCalls: request.parallelToolCalls,
      purpose: request.purpose,
      reasoningArtifactReplayObserver:
        request.onReasoningArtifactReplayDecision,
    });
    let response: Response;
    try {
      response = await generationFetch(`${baseUrl}/responses`, {
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
      if (isOperationPolicyError(error)) throw error;
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
    const reasoningArtifacts = metaReasoningArtifacts(
      model,
      parsed.reasoningItems,
      parsed.reasoningItemPositions,
    );
    const usage = withReasoningObservation(
      parsed.usage ?? parseMetaUsage((data as Record<string, unknown>).usage),
      Boolean(parsed.reasoningSummary.trim()),
    );
    if (!parsed.text.trim() && parsed.toolCalls.length === 0) {
      const respStatus = (data as Record<string, unknown>).status;
      const details = (data as Record<string, unknown>).incomplete_details as Record<string, unknown> | undefined;
      if (respStatus === "incomplete" && details?.reason === "max_output_tokens") {
        const retryRequest = incompleteBudgetRetry(request, Boolean(request.thinking?.enabled));
        if (retryRequest) {
          completeGenerationAttempt("failure", usage);
          retryRequest.attemptReason = "provider-retry";
          return metaProvider.complete(retryRequest, auth);
        }
        throw budgetExhaustedError(request, Boolean(request.thinking?.enabled), JSON.stringify(data));
      }
    }
    if (
      !parsed.text.trim() &&
      parsed.toolCalls.length === 0 &&
      !parsed.reasoningSummary.trim()
    ) {
      throw new ProviderError(`Meta Model API returned no completion text (model=${model}). The response was empty — try /effort off, raise max_tokens, or pick another model with /model.`);
    }
    return {
      text: parsed.text,
      provider: "meta",
      model,
      ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
      ...(parsed.toolCalls.length ? { finishReason: "tool_calls" } : { finishReason: "stop" }),
      ...(usage ? { usage } : {}),
      ...(parsed.reasoningItems.length
        ? { reasoningBlock: { text: parsed.reasoningSummary, items: parsed.reasoningItems } }
        : {}),
      ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
    };
      },
    );
  },
  async stream(request: CompletionRequest, auth: ProviderAuth, onToken: (token: string) => void): Promise<CompletionResult> {
    if (!auth.apiKey) throw new Error("Meta Model API key is required");
    const model = request.model ?? defaultModels.meta;
    return runGenerationAttempt(
      request,
      {
        provider: "meta",
        model,
        mode: "stream",
        reason: request.attemptReason ?? "initial",
      },
      async () => {
    const reasoningOn = Boolean(request.thinking?.enabled);
    const idleTimeoutMs = THINKING_STREAM_IDLE_TIMEOUT_MS;
    const initialIdleTimeoutMs = THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS;
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
      tools: request.tools,
      parallelToolCalls: request.parallelToolCalls,
      purpose: request.purpose,
      reasoningArtifactReplayObserver:
        request.onReasoningArtifactReplayDecision,
    });

    let response: Response | undefined;
    let lastFetchError: unknown;
    for (let fetchAttempt = 0; fetchAttempt < 2; fetchAttempt++) {
      if (fetchAttempt > 0) {
        await new Promise((r) => setTimeout(r, 1000));
        if (request.signal?.aborted) throw request.signal.reason;
        if (idleFired) break;
        armTransportTimer(initialIdleTimeoutMs);
        if (outputTimer) {
          clearTimeout(outputTimer);
          outputTimer = setTimeout(() => fireStall("output", outputIdleTimeoutMs), outputIdleTimeoutMs);
        }
      }
      try {
        response = await generationFetch(`${baseUrl}/responses`, {
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
        lastFetchError = undefined;
        break;
      } catch (error) {
        lastFetchError = error;
        if (idleFired) {
          clearIdleTimers();
          request.signal?.removeEventListener("abort", onCallerAbort);
          throw new ProviderError(`Meta Model API request timed out before any response (${Math.round(firedBudgetMs / 1000)}s) — no data arrived on the connection.`);
        }
        const msg = error instanceof Error ? error.message : String(error);
        const transient = /fetch failed|network error|etimedout|enotfound|econnreset|premature close|socket.*closed|aborted without reason/i.test(msg);
        if (!transient || sawStreamProgress) throw error;
        continue;
      }
    }
    if (!response) {
      clearIdleTimers();
      request.signal?.removeEventListener("abort", onCallerAbort);
      if (lastFetchError) throw lastFetchError;
      throw new ProviderError(`Meta Model API request failed before a response was received.`);
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
      try {
        const data = await readJson<{
          output?: unknown;
          usage?: unknown;
          id?: string;
          requestId?: string;
        }>(response, idleController.signal);
        if (response.status === 202) {
          const requestId = (data as Record<string, unknown>).requestId ?? (data as Record<string, unknown>).id;
          throw new ProviderError(
            `Meta Model API returned a pending async response${requestId ? ` (${requestId})` : ""}; streaming did not start.`,
            response.status,
            JSON.stringify(data).slice(0, 1_000),
          );
        }
        const parsed = parseResponsesOutput(data);
        const reasoningArtifacts = metaReasoningArtifacts(
          model,
          parsed.reasoningItems,
          parsed.reasoningItemPositions,
        );
        const usageTmp = parsed.usage ?? parseMetaUsage((data as Record<string, unknown>).usage);
        const jsonStatus = (data as Record<string, unknown>).status;
        const jsonDetails = (data as Record<string, unknown>).incomplete_details as Record<string, unknown> | undefined;
        if (!parsed.text.trim() && parsed.toolCalls.length === 0 && jsonStatus === "incomplete" && jsonDetails?.reason === "max_output_tokens") {
          const retryRequest = incompleteBudgetRetry(request, reasoningOn);
          const streamMethod = metaProvider.stream;
          if (retryRequest && streamMethod) {
            completeGenerationAttempt("failure", usageTmp);
            retryRequest.attemptReason = "provider-retry";
            return streamMethod(retryRequest, auth, onToken);
          }
          completeGenerationAttempt("failure", usageTmp);
          throw budgetExhaustedError(request, reasoningOn, JSON.stringify(data));
        }
        if (
          parsed.text.trim() ||
          parsed.toolCalls.length > 0 ||
          parsed.reasoningSummary.trim()
        ) {
          emitStreamReasoningArtifacts(request.onStreamEvent, reasoningArtifacts);
          if (parsed.text) onToken(parsed.text);
          return {
            text: parsed.text,
            provider: "meta",
            model,
            ...(parsed.toolCalls.length ? { toolCalls: parsed.toolCalls } : {}),
            ...(parsed.toolCalls.length ? { finishReason: "tool_calls" } : { finishReason: "stop" }),
            ...(usageTmp ? { usage: usageTmp } : {}),
            ...(parsed.reasoningItems.length
              ? { reasoningBlock: { text: parsed.reasoningSummary, items: parsed.reasoningItems } }
              : {}),
            ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
          };
        }
        throw new ProviderError(`Meta Model API returned JSON instead of an SSE stream, but no completion text was present.`, response.status, JSON.stringify(data).slice(0, 1_000));
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
            `Meta Model API stream stalled — ${STREAM_STALL_MARKER} for ${seconds}s`,
          );
        }
        throw error;
      } finally {
        clearIdleTimers();
        request.signal?.removeEventListener("abort", onCallerAbort);
      }
    }

    const decoder = new TextDecoder();
    const reader = response.body.getReader();
    let buffer = "";
    let full = "";
    let visible = "";
    let reasoningSeen = "";
    let finishReason: string | undefined;
    let sawTerminalProof: StreamTerminalProof | undefined;
    let streamUsage: TokenUsage | undefined;
    const toolCallState = new Map<string, { id?: string; name?: string; arguments: string; callId?: string }>();
    const outputIndexToItemId = new Map<number, string>();
    const outputIndexToToolCallIndex = new Map<number, number>();
    let responseId: string | undefined;
    const reasoningItems: Array<Record<string, unknown>> = [];
    const reasoningItemSequences: number[] = [];
    const reasoningItemToolCallIndices: Array<number | undefined> = [];
    const reasoningItemIndexes = new Map<string, number>();
    const noteReasoningItem = (
      item: Record<string, unknown>,
      sequence?: number | undefined,
      toolCallIndex?: number | undefined,
    ): void => {
      const encrypted = typeof item.encrypted_content === "string" ? item.encrypted_content : "";
      if (!encrypted) return;
      const id = typeof item.id === "string" ? item.id : undefined;
      const key = id ?? encrypted.slice(0, 64);
      const existingIndex = reasoningItemIndexes.get(key);
      if (existingIndex !== undefined) {
        reasoningItems[existingIndex] = { ...item };
        if (sequence !== undefined) reasoningItemSequences[existingIndex] = sequence;
        if (toolCallIndex !== undefined) {
          reasoningItemToolCallIndices[existingIndex] = toolCallIndex;
        }
        return;
      }
      reasoningItemIndexes.set(key, reasoningItems.length);
      reasoningItems.push({ ...item });
      reasoningItemSequences.push(sequence ?? Number.MAX_SAFE_INTEGER);
      reasoningItemToolCallIndices.push(toolCallIndex);
    };
    const reasoningReplay = () => {
      if (!reasoningItems.length) {
        return reasoningSeen ? { reasoningBlock: { text: reasoningSeen } } : {};
      }
      const toolCallSequences = [...outputIndexToToolCallIndex.entries()]
        .map(([sequence, toolCallIndex]) => ({ sequence, toolCallIndex }))
        .sort((left, right) => left.sequence - right.sequence);
      const positions = reasoningItemSequences.map((sequence, index) => {
        const storedToolCallIndex = reasoningItemToolCallIndices[index];
        if (storedToolCallIndex !== undefined) {
          return { sequence, toolCallIndex: storedToolCallIndex };
        }
        const followingTool = toolCallSequences.find(
          (toolCall) => toolCall.sequence > sequence,
        );
        return followingTool
          ? { sequence, toolCallIndex: followingTool.toolCallIndex }
          : { sequence };
      });
      const reasoningArtifacts = metaReasoningArtifacts(
        model,
        reasoningItems,
        positions,
      );
      emitStreamReasoningArtifacts(request.onStreamEvent, reasoningArtifacts);
      return {
        reasoningBlock: { text: reasoningSeen, items: reasoningItems },
        ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
      };
    };
    const usageResult = (): { usage: TokenUsage } | Record<string, never> => {
      const usage = withReasoningObservation(
        streamUsage,
        Boolean(reasoningSeen.trim()),
      );
      return usage ? { usage } : {};
    };

    const emitVisible = (text: string): void => {
      if (!text) return;
      visible += text;
      full += text;
      onToken(text);
    };
    const emitReasoningDelta = (text: string): void => {
      if (!text) return;
      reasoningSeen += text;
      emitStreamReasoningDelta(request.onStreamEvent, text);
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
                return { text: full, provider: "meta", model, finishReason: finishReason ?? "stop", ...usageResult(), ...reasoningReplay() };
              }
              throw new ProviderError(`Meta Model API completed without a visible answer.`);
            }
            return {
              text: full,
              provider: "meta",
              model,
              ...(toolCalls.length ? { toolCalls } : {}),
              ...(finishReason ? { finishReason } : toolCalls.length ? { finishReason: "tool_calls" } : {}),
              ...usageResult(),
              ...reasoningReplay(),
            };
          }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (parsed.error) {
            const rawDetail =
              typeof parsed.error === "string"
                ? parsed.error
                : ((parsed.error as Record<string, unknown>).message as string | undefined) ?? ((parsed.error as Record<string, unknown>).type as string | undefined) ?? "unknown error";
            const detail = rawDetail.trim().length <= 2 ? `${rawDetail} — ${payload.slice(0, 300)}` : rawDetail;
            throw new ProviderError(`Meta Model API stream error: ${detail}`, undefined, payload.slice(0, 1000));
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
              const toolCallIndex = toolCallState.size;
              toolCallState.set(id, { id, callId, name, arguments: args });
              if (outputIndex !== undefined) {
                outputIndexToToolCallIndex.set(outputIndex, toolCallIndex);
              }
              resetIdleTimer();
              if (request.onToolCallDelta) {
                const canonical = name ? fromWireName(name) ?? name : undefined;
                request.onToolCallDelta({ index: toolCallState.size - 1, ...(callId ? { id: callId } : {}), ...(canonical ? { name: canonical } : {}), argumentsBytes: args.length });
              }
            } else if (item.type === "reasoning") {
              noteReasoningItem(item, outputIndex);
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
            if (item?.type === "reasoning") {
              noteReasoningItem(
                item,
                typeof parsed.output_index === "number"
                  ? parsed.output_index
                  : undefined,
              );
            }
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
            sawTerminalProof = "response-completed";
            const resp = (parsed.response ?? parsed) as Record<string, unknown>;
            if (resp.usage) {
              const u = parseMetaUsage(resp.usage);
              if (u) streamUsage = u;
            }
            if (typeof resp.status === "string") finishReason = resp.status as string;
            if (Array.isArray(resp.output)) {
              const out = parseResponsesOutput(resp as { output?: unknown; usage?: unknown });
              for (const [index, item] of out.reasoningItems.entries()) {
                const position = out.reasoningItemPositions[index];
                noteReasoningItem(
                  item,
                  position?.sequence,
                  position?.toolCallIndex,
                );
              }
              if (out.reasoningSummary && !reasoningSeen.trim()) {
                emitReasoningDelta(out.reasoningSummary);
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
            if (type === "response.incomplete") {
              const details = resp.incomplete_details as Record<string, unknown> | undefined;
              const reason = typeof details?.reason === "string" ? details.reason : "";
              if (resp.usage) {
                const u = parseMetaUsage(resp.usage);
                if (u) streamUsage = u;
              }
              if (reason === "max_output_tokens" && !visible.trim() && toolCallState.size === 0) {
                const retryRequest = reasoningSeen.trim()
                  ? undefined
                  : incompleteBudgetRetry(request, reasoningOn);
                const streamMethod = metaProvider.stream;
                if (retryRequest && streamMethod && !request.signal?.aborted) {
                  cleanup();
                  completeGenerationAttempt("failure", streamUsage);
                  retryRequest.attemptReason = "provider-retry";
                  return streamMethod(retryRequest, auth, onToken);
                }
                completeGenerationAttempt("failure", streamUsage);
                throw budgetExhaustedError(request, reasoningOn, payload);
              }
            finishReason = "incomplete";
            sawTerminalProof = "response-incomplete";
            continue;
            }
            const err = resp.error as Record<string, unknown> | undefined;
            const rawDetail = err?.message ?? err?.code ?? type;
            const rawStr = String(rawDetail);
            const detail = rawStr.trim().length <= 2 ? `${rawStr} — ${payload.slice(0, 300)}` : rawStr;
            throw new ProviderError(`Meta Model API stream error: ${detail}`, undefined, payload.slice(0, 1000));
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
        reasoningSeen += note;
        emitStreamReasoningDelta(request.onStreamEvent, note);
      }
      cleanup();
      let metaToolArgumentBytes = 0;
      for (const state of toolCallState.values()) {
        metaToolArgumentBytes += state.arguments.length;
      }
      requireTerminalProof({
        provider: "Meta Model API",
        policy: META_STREAM_TERMINAL,
        signal: sawTerminalProof,
        answerBytes: full.length,
        reasoningBytes: reasoningSeen.length,
        toolArgumentBytes: metaToolArgumentBytes,
      });
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
          return { text: full, provider: "meta", model, finishReason: finishReason ?? "stop", ...usageResult(), ...reasoningReplay() };
        }
        throw new ProviderError(`Meta Model API completed without a visible answer.`);
      }
      return {
        text: full,
        provider: "meta",
        model,
        ...(toolCalls.length ? { toolCalls } : {}),
        ...(finishReason ? { finishReason } : toolCalls.length ? { finishReason: "tool_calls" } : {}),
        ...usageResult(),
        ...reasoningReplay(),
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
    );
  },
};
