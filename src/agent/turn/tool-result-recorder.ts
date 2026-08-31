import type { ChatMessage, ToolCall, ToolResult } from "../../types.js";
import { dedupeToolContextOutput } from "../reliability-policy.js";
import {
  maybeAppendPlanModeReminder,
  PLAN_REMINDER_TOAST,
} from "../plan-mode-reminders.js";
import { appendToolResult } from "../tool-history.js";

export interface ToolResultRecorderPorts {
  readonly messages: ChatMessage[];
  readonly useNativeToolHistory: boolean;
  readonly deferredPostToolMessages: ChatMessage[];
  readonly seenHashes: Map<string, { toolName: string; count: number }>;
  readonly remindedAt: Set<number>;
  readonly writeNotice: (level: "info" | "warn", text: string) => void;
}

export interface ToolResultRecord {
  readonly id: string;
  readonly call: ToolCall;
  readonly result: ToolResult;
  readonly contextOutput: string;
  readonly isPlanMode: boolean;
  readonly planApproved: boolean;
  readonly hasDraftPlan: boolean;
  readonly productiveStep: number;
  readonly kindHint: "pentest" | "coding" | "general";
}

const deferredImageMessage = (
  call: ToolCall,
  result: ToolResult,
): ChatMessage | undefined => {
  if (!result.images?.length) return undefined;
  const count = result.images.length;
  return {
    role: "user",
    internal: true,
    content:
      `[${call.name}] The ${count === 1 ? "image" : `${count} images`} you asked to look at ` +
      `${count === 1 ? "is" : "are"} attached to this message` +
      `${count === 1 ? "" : ", in the order you requested them"}: ` +
      `${result.images.map((image) => image.path ?? "(unnamed)").join(", ")}. ` +
      "Judge them from the pixels and continue the task.",
    images: result.images,
  };
};

export const createToolResultRecorder = (ports: ToolResultRecorderPorts) => ({
  record: (record: ToolResultRecord): void => {
    const deduped = dedupeToolContextOutput({
      content: record.contextOutput,
      toolName: record.call.name,
      artifactPath: record.result.outputPath,
      seenHashes: ports.seenHashes,
    });
    let toolContent =
      `Tool ${record.call.name} result ` +
      `(exit=${record.result.exitCode ?? 0}, ok=${record.result.ok}):\n${deduped.content}`;
    const reminded = maybeAppendPlanModeReminder(toolContent, {
      isPlanMode: record.isPlanMode,
      planApproved: record.planApproved,
      hasDraftPlan: record.hasDraftPlan,
      productiveStep: record.productiveStep,
      alreadyRemindedAt: ports.remindedAt,
      step: record.productiveStep,
      kindHint: record.kindHint,
    });
    toolContent = reminded.content;
    if (reminded.reminded) {
      ports.remindedAt.add(record.productiveStep);
      ports.writeNotice("info", PLAN_REMINDER_TOAST);
    }
    if (ports.useNativeToolHistory) {
      appendToolResult(
        ports.messages,
        record.id,
        toolContent,
        record.call.name,
        record.result.ok,
      );
    } else {
      ports.messages.push({ role: "tool", content: toolContent });
    }
    const deferred = deferredImageMessage(record.call, record.result);
    if (deferred) ports.deferredPostToolMessages.push(deferred);
  },
});
