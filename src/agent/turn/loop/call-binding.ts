import type {
  ChatMessage,
  NativeToolCall,
  ToolCall,
} from "../../../types.js";
import type { BoundCall } from "../contracts.js";
import { normalizeToolCall } from "../../../tools/registry.js";
import { parseAllToolCalls } from "../../tool-call-parser.js";
import {
  ensureUniqueToolCallIds,
  toolCallIdsInHistory,
} from "../../tool-history.js";

export const syntheticToolCallId = (index: number): string =>
  `call_text_${index}`;

const boundFromNative = (native: NativeToolCall, index: number): BoundCall => {
  const call = native.args?._parseError
    ? {
        name: native.name || "unknown",
        args: {
          __nativeParseError: true,
          _raw: native.args._raw,
        },
      }
    : normalizeToolCall({ name: native.name, args: native.args });
  return { index, id: native.id, call, native, wireId: native.id };
};

const boundFromText = (rawCall: ToolCall, index: number): BoundCall => {
  const call = normalizeToolCall(rawCall);
  const id = syntheticToolCallId(index);
  return { index, id, call, native: { id, name: call.name, args: call.args } };
};

export const bindToolCalls = (input: {
  readonly nativeToolCalls: readonly NativeToolCall[];
  readonly visible: string;
  readonly thinkContent: string;
  readonly primaryCall: ToolCall | undefined;
}): BoundCall[] => {
  if (input.nativeToolCalls.length) {
    return input.nativeToolCalls.map(boundFromNative);
  }
  let parsed = parseAllToolCalls(input.visible || input.thinkContent);
  if (parsed.length === 0 && input.primaryCall) parsed = [input.primaryCall];
  return parsed.map(boundFromText);
};

export interface ReconciledCallIds {
  readonly historyNativeCalls: NativeToolCall[];
  readonly bound: BoundCall[];
  readonly toRun: BoundCall[];
}

export const reconcileToolCallIds = (
  bound: readonly BoundCall[],
  toRun: readonly BoundCall[],
  messages: readonly ChatMessage[],
): ReconciledCallIds => {
  const historyNativeCalls = ensureUniqueToolCallIds(
    bound.map((entry) => entry.native),
    toolCallIdsInHistory(messages),
  );
  const rebound = bound.map((entry, index) => {
    const fixed = historyNativeCalls[index]!;
    return { ...entry, id: fixed.id, native: fixed };
  });
  const reboundToRun = toRun
    .map((old) => rebound.find((entry) => entry.call === old.call) ?? old)
    .map((entry, index) => ({ ...entry, index }));
  return { historyNativeCalls, bound: rebound, toRun: reboundToRun };
};
