import type { ToolCall, ToolResult } from "../../types.js";
import { sanitizeDisplayText as sanitizeAssistantText } from "../../ui-core/rendering/sanitize-display.js";
import type { SessionPlan } from "../../store/plan.js";
import { formatToolArgs } from "../tool-call-parser.js";
import type { AgentEvent } from "../events.js";
import type { TurnEventPort, TurnOutputState } from "./contracts.js";

type Emit = TurnEventPort["emit"];

const emitStatus = (emit: Emit, text: string): void => {
  let cleaned = text.replace(/\s+/g, " ").trim();
  if (/\/output\b|open full output|Ctrl\+O or|\.clai\/outputs/i.test(cleaned)) return;
  const keyLine = /^(using |switching |⏳ |all .+ API keys)/i.test(cleaned);
  const maxLen = keyLine ? 96 : 64;
  if (cleaned.length > maxLen) {
    if (keyLine) {
      cleaned = cleaned.slice(0, maxLen - 1) + "…";
    } else {
      const short = cleaned.match(/^[\w./-]+/);
      cleaned = short ? short[0]! : cleaned.slice(0, maxLen - 3) + "…";
    }
  }
  emit({ type: "status", text: cleaned || "working" });
};

const emitNotice = (emit: Emit, level: "info" | "warn", text: string): void => {
  emit({ type: "notice", level, text });
};

const emitAssistantMessage = (
  emit: Emit,
  state: TurnOutputState,
  text: string,
): void => {
  const clean = sanitizeAssistantText(text);
  if (!clean.trim()) return;
  state.visibleCommitted = true;
  emit({ type: "assistant-message", text: clean });
};

const emitThinkingBlock = (emit: Emit, content: string): void => {
  emit({ type: "thinking-block", content });
};

const emitToolOutput = (
  emit: Emit,
  id: string,
  chunk: string,
  options?: { replace?: boolean },
): void => {
  emit({
    type: "tool-output",
    id,
    chunk,
    ...(options?.replace ? { replace: true } : {}),
  });
};

const emitToolCall = (emit: Emit, id: string, call: ToolCall): void => {
  emit({
    type: "tool-call",
    id,
    name: call.name,
    argsDisplay: formatToolArgs(call),
  });
};

const emitPlanUpdate = (emit: Emit, plan: SessionPlan): void => {
  emit({ type: "plan-update", plan });
};

const emitToolBlocked = (
  emit: Emit,
  id: string,
  name: string,
  reason: string,
): void => {
  emit({ type: "tool-blocked", id, name, reason });
};

const emitAbort = (emit: Emit): void => {
  emit({ type: "turn-aborted" });
};

const emitToolResultEvent = (
  emit: Emit,
  id: string,
  result: ToolResult,
  summary: string,
  artifactPath?: string,
): void => {
  const event: Extract<AgentEvent, { type: "tool-result" }> = {
    type: "tool-result",
    id,
    ok: result.ok,
    summary,
  };
  if (typeof result.exitCode === "number") event.exitCode = result.exitCode;
  if (typeof result.runFailure === "boolean") {
    event.runFailure = result.runFailure;
  }
  if (artifactPath) event.artifactPath = artifactPath;
  if (result.fileChanges && result.fileChanges.length > 0) {
    event.fileChanges = result.fileChanges;
  }
  emit(event);
};

const emitCompactionStarted = (emit: Emit, id: string, beforeTokens: number): void => {
  emit({ type: "compaction-start", id, beforeTokens });
};

const emitCompactionDelta = (
  emit: Emit,
  id: string,
  text: string,
  replace = false,
): void => {
  if (!text && !replace) return;
  emit({
    type: "compaction-delta",
    id,
    text,
    ...(replace ? { replace: true } : {}),
  });
};

const emitCompactionCompleted = (
  emit: Emit,
  id: string,
  summary: string,
  beforeTokens: number,
  afterTokens: number,
): void => {
  emit({
    type: "compaction-completed",
    id,
    summary,
    beforeTokens,
    afterTokens,
    contextScope: "assembled-request",
  });
};

const emitCompactionFailed = (
  emit: Emit,
  id: string,
  message: string,
  retainedTokens: number,
): void => {
  emit({ type: "compaction-failed", id, message, retainedTokens });
};

export const createTurnEventEmitter = (
  port: TurnEventPort,
  state: TurnOutputState,
) => ({
  writeStatus: (text: string): void => emitStatus(port.emit, text),
  writeNotice: (level: "info" | "warn", text: string): void =>
    emitNotice(port.emit, level, text),
  writeAssistantMessage: (text: string): void =>
    emitAssistantMessage(port.emit, state, text),
  writeThinkingBlock: (content: string): void => emitThinkingBlock(port.emit, content),
  writeToolOutput: (
    id: string,
    chunk: string,
    options?: { replace?: boolean },
  ): void => emitToolOutput(port.emit, id, chunk, options),
  writeToolCall: (id: string, call: ToolCall): void => emitToolCall(port.emit, id, call),
  writePlanUpdate: (plan: SessionPlan): void => emitPlanUpdate(port.emit, plan),
  writeToolBlocked: (id: string, name: string, reason: string): void =>
    emitToolBlocked(port.emit, id, name, reason),
  writeAbort: (): void => emitAbort(port.emit),
  emitToolResult: (
    id: string,
    result: ToolResult,
    summary: string,
    artifactPath?: string,
  ): void => emitToolResultEvent(port.emit, id, result, summary, artifactPath),
  writeCompactionStarted: (id: string, beforeTokens: number): void =>
    emitCompactionStarted(port.emit, id, beforeTokens),
  writeCompactionDelta: (id: string, text: string, replace = false): void =>
    emitCompactionDelta(port.emit, id, text, replace),
  writeCompactionCompleted: (
    id: string,
    summary: string,
    beforeTokens: number,
    afterTokens: number,
  ): void => emitCompactionCompleted(port.emit, id, summary, beforeTokens, afterTokens),
  writeCompactionFailed: (
    id: string,
    message: string,
    retainedTokens: number,
  ): void => emitCompactionFailed(port.emit, id, message, retainedTokens),
});
