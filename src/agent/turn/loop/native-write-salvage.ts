import type {
  ChatMessage,
  CompletionResult,
  NativeToolCall,
} from "../../../types.js";
import type { SalvagedWrite } from "../../tool-call-parser.js";
import { salvageTruncatedWriteFromNative } from "../../tool-call-parser.js";
import {
  appendAssistantWithTools,
  appendToolResult,
  ensureUniqueToolCallIds,
  toolCallIdsInHistory,
} from "../../tool-history.js";
import type { SalvagedWriteOutcome } from "./tool-call-recovery.js";

const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "fs.write",
  "fs.append",
  "fs.writeMany",
]);

export interface NativeSalvagePorts {
  readonly messages: ChatMessage[];
  readonly toolsAttached: boolean;
  readonly notify: (level: "info" | "warn", message: string) => void;
  readonly applySalvagedWrite: (
    salvaged: SalvagedWrite,
  ) => Promise<SalvagedWriteOutcome>;
}

export interface NativeSalvageInput {
  readonly nativeToolCalls: readonly NativeToolCall[];
  readonly assistantVisible: string;
  readonly assistantThinkContent: string;
  readonly hasThinking: boolean;
  readonly completion: Pick<
    CompletionResult,
    "reasoningBlock" | "reasoningArtifacts"
  >;
}

const findTruncatedWrite = (
  calls: readonly NativeToolCall[],
): NativeToolCall | undefined =>
  calls.find(
    (call) => WRITE_TOOLS.has(call.name) && Boolean(call.args?._parseError),
  );

const rawArgumentsOf = (call: NativeToolCall): string | undefined =>
  call.rawArguments ??
  (typeof call.args?._raw === "string" ? String(call.args._raw) : undefined);

const appendNudgeText = (
  ports: NativeSalvagePorts,
  salvaged: SalvagedWrite,
  lineCount: number,
  priorBytes: number,
): string => {
  const toolName = salvaged.operation === "append" ? "fs.append" : "fs.write";
  const head =
    `Your ${toolName} tool call was cut off at the token limit, but the system salvaged the partial content and wrote ${lineCount} lines (file is now ${priorBytes} bytes) to ${salvaged.path}. ` +
    `The file ends with: ${JSON.stringify(salvaged.lastLine)}\n\n`;
  return ports.toolsAttached
    ? head +
        `CONTINUE by calling fs.append with path=${JSON.stringify(salvaged.path)}, expectedPriorBytes=${priorBytes}, and content set to ONLY the next remaining chunk not already on disk. Keep each chunk under 24,000 characters and wait for its receipt before sending another. ` +
        `Do not re-read the full file; do not re-send content already saved. Use the platform tool interface — no markdown fences.`
    : head +
        `CONTINUE with one fs.append chunk under 24,000 characters, then wait for its receipt before sending another:\n` +
        '```tool\n{"name":"fs.append","args":{"path":' +
        JSON.stringify(salvaged.path) +
        ',"expectedPriorBytes":' +
        priorBytes +
        ',"content":"...ONLY the remaining content not already on disk..."}}\n```';
};

const pairSalvagedHistory = (
  ports: NativeSalvagePorts,
  input: NativeSalvageInput,
  salvagedCall: NativeToolCall,
  salvaged: SalvagedWrite,
  lineCount: number,
): void => {
  const historyCalls = ensureUniqueToolCallIds(
    [...input.nativeToolCalls],
    toolCallIdsInHistory(ports.messages),
  );
  const salvagedIndex = input.nativeToolCalls.indexOf(salvagedCall);
  const salvagedToolName =
    salvaged.operation === "append" ? "fs.append" : "fs.write";
  const salvagedHistoryArgs: Record<string, unknown> = {
    path: salvaged.path,
    content: salvaged.content,
    ...(salvaged.operation === "append"
      ? {
          position: "end",
          ...(typeof salvaged.expectedPriorBytes === "number"
            ? { expectedPriorBytes: salvaged.expectedPriorBytes }
            : {}),
        }
      : {}),
  };
  const salvagedCallId = historyCalls[salvagedIndex]?.id ?? salvagedCall.id;
  if (salvagedIndex >= 0) {
    historyCalls[salvagedIndex] = {
      id: salvagedCallId,
      name: salvagedToolName,
      args: salvagedHistoryArgs,
      rawArguments: JSON.stringify(salvagedHistoryArgs),
    };
  }
  appendAssistantWithTools(
    ports.messages,
    input.assistantVisible,
    historyCalls,
    input.completion.reasoningBlock ??
      (input.hasThinking && input.assistantThinkContent
        ? { text: input.assistantThinkContent }
        : undefined),
    input.completion.reasoningArtifacts,
  );
  for (const call of historyCalls) {
    appendToolResult(
      ports.messages,
      call.id,
      call.id === salvagedCallId
        ? `Tool ${call.name} result (exit=0, ok=true):\nSalvaged partial write: ${lineCount} lines to ${salvaged.path}`
        : `Tool ${call.name} result (exit=1, ok=false):\nCancelled — sibling write was truncated and salvaged.`,
      call.name,
      call.id === salvagedCallId,
    );
  }
};

export const hasTruncatedNativeWrite = (
  calls: readonly NativeToolCall[],
): boolean => {
  const writeCall = findTruncatedWrite(calls);
  if (!writeCall) return false;
  return Boolean(
    salvageTruncatedWriteFromNative(writeCall.name, rawArgumentsOf(writeCall)),
  );
};

export const salvageTruncatedNativeWrite = async (
  ports: NativeSalvagePorts,
  input: NativeSalvageInput,
): Promise<boolean> => {
  const writeCall = findTruncatedWrite(input.nativeToolCalls);
  if (!writeCall) return false;
  const salvaged = salvageTruncatedWriteFromNative(
    writeCall.name,
    rawArgumentsOf(writeCall),
  );
  if (!salvaged) return false;
  try {
    const outcome = await ports.applySalvagedWrite(salvaged);
    if (!outcome.ok) return false;
    const lineCount = salvaged.content.split("\n").length;
    ports.notify(
      "info",
      `native tool call was truncated — salvaged ${lineCount} lines and wrote to ${salvaged.path}`,
    );
    pairSalvagedHistory(ports, input, writeCall, salvaged, lineCount);
    ports.messages.push({
      role: "user",
      content: appendNudgeText(ports, salvaged, lineCount, outcome.bytesOnDisk),
    });
    return true;
  } catch {
    return false;
  }
};
