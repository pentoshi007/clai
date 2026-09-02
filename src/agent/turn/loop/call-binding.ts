import type {
  ChatMessage,
  NativeToolCall,
  ToolCall,
} from "../../../types.js";
import type { BoundCall } from "../contracts.js";
import { parseAllToolCalls } from "../../tool-call-parser.js";
import {
  ensureUniqueToolCallIds,
  toolCallIdsInHistory,
} from "../../tool-history.js";
import {
  canonicalizeTurnCall,
  type ToolNameCanonicalizer,
} from "./canonicalize-turn-call.js";

export const syntheticToolCallId = (index: number): string =>
  `call_text_${index}`;

const boundFromNative = (
  native: NativeToolCall,
  index: number,
  mcpRuntime?: ToolNameCanonicalizer | undefined,
): BoundCall => {
  const call = native.args?._parseError
    ? {
        name: native.name || "unknown",
        args: {
          __nativeParseError: true,
          _raw: native.args._raw,
        },
      }
    : canonicalizeTurnCall({ name: native.name, args: native.args }, mcpRuntime);
  return { index, id: native.id, call, native, wireId: native.id };
};

const boundFromText = (
  rawCall: ToolCall,
  index: number,
  mcpRuntime?: ToolNameCanonicalizer | undefined,
): BoundCall => {
  const call = canonicalizeTurnCall(rawCall, mcpRuntime);
  const id = syntheticToolCallId(index);
  return { index, id, call, native: { id, name: call.name, args: call.args } };
};

export const bindToolCalls = (input: {
  readonly nativeToolCalls: readonly NativeToolCall[];
  readonly visible: string;
  readonly thinkContent: string;
  readonly primaryCall: ToolCall | undefined;
  readonly mcpRuntime?: ToolNameCanonicalizer | undefined;
}): BoundCall[] => {
  if (input.nativeToolCalls.length) {
    return input.nativeToolCalls.map((native, index) =>
      boundFromNative(native, index, input.mcpRuntime),
    );
  }
  let parsed = parseAllToolCalls(input.visible || input.thinkContent);
  if (parsed.length === 0 && input.primaryCall) parsed = [input.primaryCall];
  return parsed.map((rawCall, index) =>
    boundFromText(rawCall, index, input.mcpRuntime),
  );
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
