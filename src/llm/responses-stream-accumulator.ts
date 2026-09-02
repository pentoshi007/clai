import type { CompletionRequest } from "../types.js";
import { toWireName } from "./tool-protocol.js";
import { wireToolArguments } from "./tool-wire/argument-repair.js";
import { withReasoningObservation } from "./token-usage.js";
import type { TokenUsage } from "./token-usage.js";
import { emitStreamReasoningArtifacts } from "./stream-events.js";
import type { StreamTerminalProof } from "./provider-profile.js";
import type { ResponsesDialectConfig } from "./responses-config.js";
import {
  parseResponsesOutput,
  responsesReasoningArtifacts,
} from "./responses-parse.js";
import type {
  ResponsesReasoningItemPosition,
  ToolCallAccumulator,
} from "./responses-parse.js";
import type { StreamIdleWatchdog } from "./responses-stream-watchdog.js";

export interface StreamAccumulator {
  full: string;
  visible: string;
  reasoningSeen: string;
  finishReason: string | undefined;
  sawTerminalProof: StreamTerminalProof | undefined;
  streamUsage: TokenUsage | undefined;
  responseId: string | undefined;
  readonly toolCallState: Map<string, ToolCallAccumulator>;
  readonly outputIndexToItemId: Map<number, string>;
  readonly outputIndexToToolCallIndex: Map<number, number>;
  readonly reasoningItems: Array<Record<string, unknown>>;
  readonly reasoningItemSequences: number[];
  readonly reasoningItemToolCallIndices: Array<number | undefined>;
  readonly reasoningItemIndexes: Map<string, number>;
}

export function newStreamAccumulator(): StreamAccumulator {
  return {
    full: "",
    visible: "",
    reasoningSeen: "",
    finishReason: undefined,
    sawTerminalProof: undefined,
    streamUsage: undefined,
    responseId: undefined,
    toolCallState: new Map(),
    outputIndexToItemId: new Map(),
    outputIndexToToolCallIndex: new Map(),
    reasoningItems: [],
    reasoningItemSequences: [],
    reasoningItemToolCallIndices: [],
    reasoningItemIndexes: new Map(),
  };
}

export function noteReasoningItem(
  state: StreamAccumulator,
  item: Record<string, unknown>,
  sequence?: number | undefined,
  toolCallIndex?: number | undefined,
): void {
  const encrypted =
    typeof item.encrypted_content === "string" ? item.encrypted_content : "";
  if (!encrypted) return;
  const id = typeof item.id === "string" ? item.id : undefined;
  const key = id ?? encrypted.slice(0, 64);
  const existingIndex = state.reasoningItemIndexes.get(key);
  if (existingIndex !== undefined) {
    state.reasoningItems[existingIndex] = { ...item };
    if (sequence !== undefined)
      state.reasoningItemSequences[existingIndex] = sequence;
    if (toolCallIndex !== undefined) {
      state.reasoningItemToolCallIndices[existingIndex] = toolCallIndex;
    }
    return;
  }
  state.reasoningItemIndexes.set(key, state.reasoningItems.length);
  state.reasoningItems.push({ ...item });
  state.reasoningItemSequences.push(sequence ?? Number.MAX_SAFE_INTEGER);
  state.reasoningItemToolCallIndices.push(toolCallIndex);
}

function reasoningItemPositionsFor(
  state: StreamAccumulator,
): ResponsesReasoningItemPosition[] {
  const toolCallSequences = [...state.outputIndexToToolCallIndex.entries()]
    .map(([sequence, toolCallIndex]) => ({ sequence, toolCallIndex }))
    .sort((left, right) => left.sequence - right.sequence);
  return state.reasoningItemSequences.map((sequence, index) => {
    const storedToolCallIndex = state.reasoningItemToolCallIndices[index];
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
}

export function absorbResponseOutput(
  state: StreamAccumulator,
  resp: Record<string, unknown>,
  emitVisible: (text: string) => void,
  emitReasoningDelta: (text: string) => void,
): void {
  if (!Array.isArray(resp.output)) return;
  const out = parseResponsesOutput(
    resp as { output?: unknown; usage?: unknown },
  );
  for (const [index, item] of out.reasoningItems.entries()) {
    const position = out.reasoningItemPositions[index];
    noteReasoningItem(state, item, position?.sequence, position?.toolCallIndex);
  }
  // reasoningSummary is only emitted via dispatchReasoningEvent for streams; absorb here is for non-stream fallback
  if (out.text && !state.visible.trim()) emitVisible(out.text);
  for (const tc of out.toolCalls) {
    const exists = [...state.toolCallState.values()].some(
      (s) => s.callId === tc.id,
    );
    if (!exists) {
      state.toolCallState.set(tc.id, {
        id: tc.id,
        callId: tc.id,
        name: toWireName(tc.name),
        arguments: wireToolArguments(tc.rawArguments, tc.args),
      });
    }
  }
}

export function streamReasoningReplay(
  config: ResponsesDialectConfig,
  model: string,
  state: StreamAccumulator,
  onStreamEvent: CompletionRequest["onStreamEvent"],
): Record<string, unknown> {
  if (!state.reasoningSeen.trim() && !state.reasoningItems.length) return {};
  if (!state.reasoningItems.length) {
    return { reasoningBlock: { text: state.reasoningSeen } };
  }
  const positions = reasoningItemPositionsFor(state);
  const reasoningArtifacts = responsesReasoningArtifacts(
    config,
    model,
    state.reasoningItems,
    positions,
  );
  emitStreamReasoningArtifacts(onStreamEvent, reasoningArtifacts);
  return {
    reasoningBlock: { text: state.reasoningSeen, items: state.reasoningItems },
    ...(reasoningArtifacts ? { reasoningArtifacts } : {}),
  };
}

export function streamUsageResult(
  state: StreamAccumulator,
  thinkingEnabled?: boolean | undefined,
): { usage: TokenUsage } | Record<string, never> {
  const usage = withReasoningObservation(
    state.streamUsage,
    thinkingEnabled !== false && Boolean(state.reasoningSeen.trim()),
  );
  return usage ? { usage } : {};
}

export interface StreamEventContext {
  config: ResponsesDialectConfig;
  model: string;
  request: CompletionRequest;
  state: StreamAccumulator;
  watchdog: StreamIdleWatchdog;
  emitVisible: (text: string) => void;
  emitReasoningDelta: (text: string) => void;
}
