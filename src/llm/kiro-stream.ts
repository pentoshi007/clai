import type {
  NativeToolCall,
  ToolCallStreamDelta,
  UsageCharge,
} from "../types.js";
import { ProviderError } from "./http.js";
import { inBandBadRequestStatus } from "./reasoning-errors.js";
import {
  createKiroReasoningAccumulator,
  type KiroReasoningAccumulator,
} from "./kiro-reasoning.js";
import type { KiroStreamEvent } from "./kiro-sse.js";

const THINKING_OPEN = "<thinking>";
const THINKING_CLOSE = "</thinking>";

export type KiroPendingStreamEvent =
  | { kind: "token"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; delta: ToolCallStreamDelta };

export interface KiroEventStreamFrame {
  headers: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export interface KiroStreamUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  charges: UsageCharge[];
}

export interface KiroStreamAccumulator {
  applyLegacyFrame(frame: KiroEventStreamFrame): void;
  applySseEvent(event: KiroStreamEvent): void;
  finish(): void;
  /** Removes and returns the deltas produced since the last drain, for live forwarding. */
  drain(): KiroPendingStreamEvent[];
  readonly text: string;
  readonly finishReason: string;
  readonly stopReason: string;
  readonly contextUsagePercentage: number | undefined;
  readonly toolCalls: NativeToolCall[];
  readonly reasoning: KiroReasoningAccumulator;
  readonly pending: readonly KiroPendingStreamEvent[];
  readonly usage: KiroStreamUsage;
}

interface PartialToolCall {
  id: string;
  name: string;
  rawArgs: string;
  syntheticId: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstMetric(
  sources: readonly Record<string, unknown>[],
  names: readonly string[],
): number | undefined {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
  }
  return undefined;
}

function normalizeStopReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  const normalized = reason
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (["endturn", "end_turn", "stop", "stop_sequence", "completed"].includes(normalized)) {
    return "end_turn";
  }
  if (["tooluse", "tool_use", "tool_calls"].includes(normalized)) return "tool_use";
  if (["maxtokens", "max_tokens", "max_output_tokens", "length"].includes(normalized)) {
    return "max_tokens";
  }
  return normalized;
}

function stopSeverity(reason: string): number {
  if (/(?:content.*filter|guardrail|safety|policy|blocked|refusal)/u.test(reason)) return 6;
  if (["cancelled", "pause_turn"].includes(reason)) return 5;
  if (["malformed_model_output", "invalid_model_output"].includes(reason)) return 4;
  if (["max_tokens", "model_context_window_exceeded"].includes(reason)) return 3;
  if (reason === "tool_use") return 2;
  return 1;
}

function mergeStopReason(current: string, incoming: string): string {
  if (!incoming) return current;
  if (!current) return incoming;
  return stopSeverity(incoming) > stopSeverity(current) ? incoming : current;
}

function legacyEventType(frame: KiroEventStreamFrame): {
  eventType: string;
  payload: Record<string, unknown>;
} {
  const messageType =
    typeof frame.headers[":message-type"] === "string"
      ? frame.headers[":message-type"]
      : "event";
  const exceptionType =
    typeof frame.headers[":exception-type"] === "string"
      ? frame.headers[":exception-type"]
      : "";
  const eventType =
    (typeof frame.headers[":event-type"] === "string"
      ? frame.headers[":event-type"]
      : undefined) ||
    exceptionType ||
    Object.keys(frame.payload).find((key) =>
      key.endsWith("Event") || key.endsWith("Exception")
    ) ||
    "";
  const nested = asRecord(frame.payload[eventType]);
  return {
    eventType: messageType === "exception" ? exceptionType || eventType : eventType,
    payload: nested ?? frame.payload,
  };
}

export function createKiroStreamAccumulator(): KiroStreamAccumulator {
  let text = "";
  let finishReason = "stop";
  let stopReason = "";
  let contextUsagePercentage: number | undefined;
  let insideThinkingTag = false;
  let tagBuffer = "";
  let currentToolIndex = -1;
  const accumulatedTools: PartialToolCall[] = [];
  const pending: KiroPendingStreamEvent[] = [];
  const usage: KiroStreamUsage = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    charges: [],
  };
  const reasoning = createKiroReasoningAccumulator((chunk) =>
    pending.push({ kind: "reasoning", text: chunk })
  );

  const pushText = (chunk: string): void => {
    if (!chunk) return;
    text += chunk;
    pending.push({ kind: "token", text: chunk });
  };

  const partialTagSuffix = (text: string, tag: string): number => {
    const max = Math.min(text.length, tag.length - 1);
    for (let length = max; length > 0; length -= 1) {
      if (text.endsWith(tag.slice(0, length))) return length;
    }
    return 0;
  };

  const splitThinkingTags = (chunk: string): void => {
    const input = tagBuffer + chunk;
    tagBuffer = "";
    let visible = "";
    let hidden = "";
    let index = 0;
    while (index < input.length) {
      if (!insideThinkingTag) {
        const start = input.indexOf(THINKING_OPEN, index);
        if (start === -1) {
          const keep = partialTagSuffix(input.slice(index), THINKING_OPEN);
          visible += input.slice(index, input.length - keep);
          tagBuffer = input.slice(input.length - keep);
          break;
        }
        visible += input.slice(index, start);
        insideThinkingTag = true;
        index = start + THINKING_OPEN.length;
        continue;
      }
      const end = input.indexOf(THINKING_CLOSE, index);
      if (end === -1) {
        const keep = partialTagSuffix(input.slice(index), THINKING_CLOSE);
        hidden += input.slice(index, input.length - keep);
        tagBuffer = input.slice(input.length - keep);
        break;
      }
      hidden += input.slice(index, end);
      insideThinkingTag = false;
      index = end + THINKING_CLOSE.length;
    }
    reasoning.push(hidden);
    pushText(visible);
  };

  const flushThinkingBuffer = (): void => {
    if (!tagBuffer) return;
    const buffered = tagBuffer;
    tagBuffer = "";
    if (insideThinkingTag) reasoning.push(buffered);
    else pushText(buffered);
  };

  const applyToolUse = (input: {
    toolUseId?: string | undefined;
    name?: string | undefined;
    input?: unknown;
    stop: boolean;
  }): void => {
    let existing = input.toolUseId
      ? accumulatedTools.find((tool) => tool.id === input.toolUseId)
      : accumulatedTools[currentToolIndex];

    if (
      input.toolUseId &&
      !existing &&
      currentToolIndex >= 0 &&
      accumulatedTools[currentToolIndex]?.syntheticId
    ) {
      const active = accumulatedTools[currentToolIndex]!;
      active.id = input.toolUseId;
      active.syntheticId = false;
      existing = active;
    }
    if (!existing && (input.toolUseId || input.name || input.input !== undefined)) {
      existing = {
        id: input.toolUseId ?? `tool_${accumulatedTools.length + 1}`,
        name: input.name ?? "",
        rawArgs: "",
        syntheticId: input.toolUseId === undefined,
      };
      accumulatedTools.push(existing);
    }
    if (!existing) {
      if (input.stop) currentToolIndex = -1;
      return;
    }

    if (typeof input.input === "string") existing.rawArgs += input.input;
    else if (input.input && typeof input.input === "object") {
      existing.rawArgs = JSON.stringify(input.input);
    }
    if (input.name && !existing.name) existing.name = input.name;
    currentToolIndex = accumulatedTools.indexOf(existing);
    pending.push({
      kind: "tool",
      delta: {
        index: currentToolIndex,
        id: existing.id,
        name: existing.name,
        argumentsBytes: Buffer.byteLength(existing.rawArgs, "utf8"),
      },
    });
    finishReason = "tool_calls";
    if (input.stop) currentToolIndex = -1;
  };

  const applyUsageCharge = (payload: Record<string, unknown>): void => {
    if (
      typeof payload.usage !== "number" ||
      !Number.isFinite(payload.usage) ||
      payload.usage < 0 ||
      typeof payload.unit !== "string" ||
      !payload.unit.trim()
    ) {
      return;
    }
    usage.charges.push({
      amount: payload.usage,
      unit:
        typeof payload.unitPlural === "string" && payload.unitPlural.trim()
          ? payload.unitPlural.trim()
          : payload.unit.trim(),
      ...(typeof payload.currency === "string" ? { currency: payload.currency } : {}),
    });
  };

  const applyTokenMetrics = (payload: Record<string, unknown>): void => {
    const usagePayload = asRecord(payload.usage);
    const tokenUsagePayload = asRecord(payload.tokenUsage);
    const sources = [
      payload,
      ...(usagePayload ? [usagePayload] : []),
      ...(tokenUsagePayload ? [tokenUsagePayload] : []),
    ];
    const inputTokens = firstMetric(sources, [
      "inputTokens",
      "input_tokens",
      "input_token_count",
      "promptTokens",
      "prompt_tokens",
    ]);
    const outputTokens = firstMetric(sources, [
      "outputTokens",
      "output_tokens",
      "output_token_count",
      "completionTokens",
      "completion_tokens",
    ]);
    const cacheRead = firstMetric(sources, [
      "cacheReadTokens",
      "cache_read_tokens",
      "cache_read_input_token_count",
      "cacheReadInputTokens",
      "cache_read_input_tokens",
      "cachedTokens",
    ]);
    const cacheWrite = firstMetric(sources, [
      "cacheCreationTokens",
      "cache_creation_tokens",
      "cache_write_input_token_count",
      "cacheWriteTokens",
      "cache_write_tokens",
      "cacheWriteInputTokens",
      "cacheCreationInputTokens",
      "cache_creation_input_tokens",
    ]);
    if (inputTokens !== undefined) usage.promptTokens = inputTokens;
    if (outputTokens !== undefined) usage.completionTokens = outputTokens;
    if (cacheRead !== undefined) usage.cachedTokens = Math.max(usage.cachedTokens, cacheRead);
    if (cacheWrite !== undefined) {
      usage.cacheCreationTokens = Math.max(usage.cacheCreationTokens, cacheWrite);
    }
  };

  const applyLegacyFrame = (frame: KiroEventStreamFrame): void => {
    const { eventType, payload } = legacyEventType(frame);
    if (!eventType && payload.reasoningText === undefined) return;

    if (eventType.endsWith("Exception")) {
      const message =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.reason === "string"
            ? payload.reason
            : "Kiro stream exception";
      const inBand = inBandBadRequestStatus({
        type: eventType,
        code: payload.code,
        message,
      });
      const signatureFailure =
        /THINKING_SIGNATURE_INVALID|THINKING_SIGNATURE_MISMATCH/i.test(
          `${eventType} ${message}`,
        );
      throw new ProviderError(
        `${eventType}: ${message}`,
        inBand ?? (signatureFailure ? 400 : 502),
        JSON.stringify(payload),
      );
    }

    applyUsageCharge(payload);

    if (eventType === "assistantResponseEvent" || eventType.includes("Response")) {
      if (typeof payload.contextUsagePercentage === "number") {
        contextUsagePercentage = payload.contextUsagePercentage;
      }
      if (typeof payload.content === "string") splitThinkingTags(payload.content);
      return;
    }
    if (
      eventType === "reasoningContentEvent" ||
      /reasoning/i.test(eventType) ||
      payload.reasoningText !== undefined
    ) {
      const reasoningPayload = asRecord(payload.reasoningText);
      const chunk =
        typeof payload.text === "string"
          ? payload.text
          : typeof payload.content === "string"
            ? payload.content
            : typeof payload.reasoningText === "string"
              ? payload.reasoningText
              : typeof reasoningPayload?.text === "string"
                ? reasoningPayload.text
                : typeof reasoningPayload?.Text === "string"
                  ? reasoningPayload.Text
                  : "";
      reasoning.sign(
        typeof payload.signature === "string"
          ? payload.signature
          : typeof payload.Signature === "string"
            ? payload.Signature
            : typeof reasoningPayload?.signature === "string"
              ? reasoningPayload.signature
              : typeof reasoningPayload?.Signature === "string"
                ? reasoningPayload.Signature
                : "",
      );
      reasoning.redact(
        typeof payload.redactedContent === "string" ? payload.redactedContent : "",
      );
      reasoning.push(chunk);
      return;
    }
    if (eventType === "codeEvent") {
      if (typeof payload.content === "string") pushText(payload.content);
      return;
    }
    if (eventType === "toolUseEvent") {
      applyToolUse({
        toolUseId:
          typeof payload.toolUseId === "string"
            ? payload.toolUseId
            : typeof payload.tool_use_id === "string"
              ? payload.tool_use_id
              : undefined,
        name: typeof payload.name === "string" ? payload.name : undefined,
        input: payload.input,
        stop: payload.stop === true,
      });
      return;
    }
    if (eventType === "messageStopEvent") {
      stopReason = mergeStopReason(
        stopReason,
        normalizeStopReason(payload.stopReason ?? payload.stop_reason),
      );
      return;
    }
    if (eventType === "contextUsageEvent") {
      if (typeof payload.contextUsagePercentage === "number") {
        contextUsagePercentage = payload.contextUsagePercentage;
      }
      return;
    }
    if (
      eventType === "metricsEvent" ||
      eventType === "meteringEvent" ||
      /^metadataevent$/i.test(eventType)
    ) {
      applyTokenMetrics(payload);
      if (/^metadataevent$/i.test(eventType)) {
        stopReason = mergeStopReason(
          stopReason,
          normalizeStopReason(payload.stopReason ?? payload.stop_reason),
        );
      }
    }
  };

  const applySseEvent = (event: KiroStreamEvent): void => {
    switch (event.type) {
      case "keepalive":
        return;
      case "assistantResponseEvent":
        splitThinkingTags(event.content);
        return;
      case "reasoningContentEvent":
        reasoning.sign(event.signature ?? "");
        reasoning.redact(event.redactedContent ?? "");
        reasoning.push(event.text ?? "");
        return;
      case "toolUseEvent":
        applyToolUse({
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          stop: event.stop,
        });
        return;
      case "meteringEvent":
        applyUsageCharge({
          usage: event.usage,
          unit: event.unit,
          unitPlural: event.unitPlural,
        });
        return;
      case "metadataEvent":
        stopReason = mergeStopReason(stopReason, normalizeStopReason(event.stopReason));
        return;
      case "contextUsageEvent":
        contextUsagePercentage = event.contextUsagePercentage;
        return;
      case "codeReferenceEvent":
        return;
    }
  };

  return {
    applyLegacyFrame,
    applySseEvent,
    finish() {
      flushThinkingBuffer();
      reasoning.finish();
    },
    drain() {
      return pending.splice(0, pending.length);
    },
    get text() {
      return text;
    },
    get finishReason() {
      return finishReason;
    },
    get stopReason() {
      return stopReason;
    },
    get contextUsagePercentage() {
      return contextUsagePercentage;
    },
    get toolCalls() {
      return accumulatedTools.map((tool) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tool.rawArgs || "{}") as Record<string, unknown>;
        } catch {
          args = { raw: tool.rawArgs };
        }
        return {
          id: tool.id,
          name: tool.name,
          args,
          rawArguments: tool.rawArgs,
        };
      });
    },
    get reasoning() {
      return reasoning;
    },
    get pending() {
      return pending;
    },
    get usage() {
      return usage;
    },
  };
}
