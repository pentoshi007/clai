import { ProviderError } from "./http.js";

export type KiroStreamEvent =
  | { type: "keepalive" }
  | { type: "assistantResponseEvent"; content: string; modelId?: string | undefined }
  | {
      type: "reasoningContentEvent";
      text?: string | undefined;
      signature?: string | undefined;
      redactedContent?: string | undefined;
    }
  | {
      type: "toolUseEvent";
      toolUseId?: string | undefined;
      name?: string | undefined;
      input?: string | undefined;
      stop: boolean;
    }
  | {
      type: "meteringEvent";
      usage?: number | undefined;
      unit?: string | undefined;
      unitPlural?: string | undefined;
    }
  | {
      type: "metadataEvent";
      stopReason?: string | undefined;
      stopDetails?: Record<string, unknown> | undefined;
    }
  | { type: "contextUsageEvent"; contextUsagePercentage: number }
  | { type: "codeReferenceEvent"; references: unknown[] };

const KIRO_SSE_MAX_LINE_BYTES = 4 * 1024 * 1024;

const KIRO_INCOMPLETE_REASONS: Record<string, string> = {
  max_output_tokens: "MAX_TOKENS",
  content_filter: "CONTENT_FILTERED",
  compaction_required_for_model_handoff: "COMPACTION_REQUIRED_FOR_MODEL_HANDOFF",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeReasoningEnvelope(
  encrypted: string,
): { redactedContent?: string; signature?: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encrypted);
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  if (!record) return undefined;
  if (typeof record.redactedContent === "string" && record.redactedContent) {
    return { redactedContent: record.redactedContent };
  }
  const reasoningText = asRecord(record.reasoningText);
  if (typeof reasoningText?.text === "string") {
    return typeof reasoningText.signature === "string"
      ? { signature: reasoningText.signature }
      : {};
  }
  return undefined;
}

function sseFailure(payload: Record<string, unknown>, requestId?: string): ProviderError {
  const error = asRecord(payload.error) ?? payload;
  const type = String(error.type ?? error.code ?? "unknown");
  const message =
    typeof error.message === "string"
      ? error.message
      : `Kiro CreateResponse stream failed (${type})`;
  return new ProviderError(message, 502, JSON.stringify({ ...error, requestId }));
}

function callIdOf(item: Record<string, unknown>): string {
  if (typeof item.call_id === "string") return item.call_id;
  return typeof item.id === "string" ? item.id : "";
}

interface KiroSseState {
  openCalls: Set<string>;
  streamedCalls: Set<string>;
  heldStops: string[];
  activeCall: string | undefined;
  refusalStreamed: boolean;
}

function terminalEvents(
  payload: Record<string, unknown>,
  state: KiroSseState,
): KiroStreamEvent[] {
  const response = asRecord(payload.response);
  const incomplete =
    payload.type === "response.incomplete" || response?.status === "incomplete";
  const events: KiroStreamEvent[] = [];

  if (!incomplete) {
    for (const callId of state.heldStops) {
      events.push({ type: "toolUseEvent", toolUseId: callId, stop: true });
    }
    for (const callId of state.openCalls) {
      events.push({ type: "toolUseEvent", toolUseId: callId, stop: true });
    }
  }
  state.heldStops.length = 0;
  state.openCalls.clear();
  state.activeCall = undefined;

  let stopReason = "END_TURN";
  if (incomplete) {
    const details = asRecord(response?.incomplete_details);
    const reason = typeof details?.reason === "string" ? details.reason : undefined;
    stopReason = (reason && KIRO_INCOMPLETE_REASONS[reason]) ?? "END_TURN";
  }
  events.push({ type: "metadataEvent", stopReason });

  const usage = asRecord(response?.usage);
  const percentage = usage?.["kiro:context_usage_percentage"];
  if (typeof percentage === "number" && Number.isFinite(percentage)) {
    events.push({ type: "contextUsageEvent", contextUsagePercentage: percentage });
  }
  const credits = asRecord(usage?.["kiro:credits"]);
  if (typeof credits?.value === "number" && Number.isFinite(credits.value)) {
    events.push({
      type: "meteringEvent",
      usage: credits.value,
      unit: typeof credits.unit === "string" ? credits.unit : undefined,
      unitPlural: typeof credits.unit_plural === "string" ? credits.unit_plural : undefined,
    });
  }
  return events;
}

function toolItemDone(
  item: Record<string, unknown>,
  state: KiroSseState,
): KiroStreamEvent[] {
  const callId = callIdOf(item);
  if (!state.openCalls.has(callId)) return [];
  state.openCalls.delete(callId);
  const events: KiroStreamEvent[] = [];
  if (!state.streamedCalls.delete(callId)) {
    events.push({
      type: "toolUseEvent",
      toolUseId: callId,
      input: typeof item.arguments === "string" ? item.arguments : "",
      stop: false,
    });
  }
  if (item.status !== "incomplete") state.heldStops.push(callId);
  return events;
}

function outputItemDone(
  item: Record<string, unknown>,
  state: KiroSseState,
): KiroStreamEvent[] {
  if (item.type === "reasoning") {
    if (typeof item.encrypted_content !== "string") return [];
    const decoded = decodeReasoningEnvelope(item.encrypted_content);
    return decoded ? [{ type: "reasoningContentEvent", ...decoded }] : [];
  }
  return item.type === "function_call" ? toolItemDone(item, state) : [];
}

function handleSseLine(
  line: string,
  state: KiroSseState,
  requestId?: string,
): KiroStreamEvent[] {
  if (!line.startsWith("data:")) return [];
  const data = line.slice(5).trim();
  if (!data || data === "[DONE]") return [];

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(data);
    const record = asRecord(parsed);
    if (!record) return [];
    payload = record;
  } catch {
    return [];
  }

  const type = typeof payload.type === "string" ? payload.type : "";
  switch (type) {
    case "kiro:keep_alive":
      return [{ type: "keepalive" }];
    case "response.output_text.delta":
      return typeof payload.delta === "string"
        ? [{ type: "assistantResponseEvent", content: payload.delta }]
        : [];
    case "response.reasoning_text.delta":
    case "response.reasoning.delta":
      return typeof payload.delta === "string"
        ? [{ type: "reasoningContentEvent", text: payload.delta }]
        : [];
    case "response.refusal.delta":
      if (typeof payload.delta !== "string") return [];
      state.refusalStreamed = true;
      return [{ type: "assistantResponseEvent", content: payload.delta }];
    case "response.refusal.done":
      return typeof payload.refusal === "string" && !state.refusalStreamed
        ? [{ type: "assistantResponseEvent", content: payload.refusal }]
        : [];
    case "response.output_item.done": {
      const item = asRecord(payload.item);
      return item ? outputItemDone(item, state) : [];
    }
    case "response.output_item.added": {
      const item = asRecord(payload.item);
      if (item?.type !== "function_call") return [];
      const callId = callIdOf(item);
      state.openCalls.add(callId);
      state.activeCall = callId;
      return [{
        type: "toolUseEvent",
        toolUseId: callId,
        name: typeof item.name === "string" ? item.name : undefined,
        input: typeof item.arguments === "string" ? item.arguments : "",
        stop: false,
      }];
    }
    case "response.function_call_arguments.delta":
      if (typeof payload.delta !== "string") return [];
      if (state.activeCall) state.streamedCalls.add(state.activeCall);
      return [{ type: "toolUseEvent", input: payload.delta, stop: false }];
    case "response.function_call_arguments.done": {
      const callId = state.activeCall;
      if (!callId || !state.openCalls.has(callId)) return [];
      state.openCalls.delete(callId);
      state.streamedCalls.delete(callId);
      state.activeCall = undefined;
      return [{ type: "toolUseEvent", toolUseId: callId, stop: true }];
    }
    case "kiro:code_reference.added": {
      const references = Array.isArray(payload.annotations) ? payload.annotations : [];
      return references.length > 0 ? [{ type: "codeReferenceEvent", references }] : [];
    }
    case "error":
    case "response.failed":
      throw sseFailure(payload, requestId);
    case "response.completed":
    case "response.incomplete":
      return terminalEvents(payload, state);
    default:
      return [];
  }
}

/**
 * Parses the `text/event-stream` body of `POST /v1/responses` into the same
 * normalized events the legacy event-stream path produces, so downstream
 * accumulation is shared between both APIs.
 */
export async function* parseKiroCreateResponseSse(
  stream: ReadableStream<Uint8Array>,
  options: { requestId?: string | undefined } = {},
): AsyncGenerator<KiroStreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  const state: KiroSseState = {
    openCalls: new Set(),
    streamedCalls: new Set(),
    heldStops: [],
    activeCall: undefined,
    refusalStreamed: false,
  };
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) buffer += decoder.decode(value, { stream: true });
      if (buffer.length > KIRO_SSE_MAX_LINE_BYTES) {
        throw new ProviderError(
          "Kiro CreateResponse stream line exceeds its protocol bound",
          502,
        );
      }
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        for (const event of handleSseLine(line, state, options.requestId)) yield event;
      }
    }
    buffer += decoder.decode();
    if (buffer.length > 0) {
      for (const event of handleSseLine(buffer, state, options.requestId)) yield event;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
