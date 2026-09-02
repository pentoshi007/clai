import { formatToolArgs } from "../../../agent/tool-call-parser.js";
import { shouldHideQuietMetaToolInChat } from "../../../app/adapters/quiet-meta-tools.js";
import { asToolCallId } from "../../../app/events/app-event.js";
import type { ToolCallId } from "../../../app/events/app-event.js";
import { buildFileChange, isFileMutationTool } from "../../../tools/file-diff.js";
import type { FileChange } from "../../../tools/file-diff.js";
import { isInternalChatMessage } from "../../../types.js";
import type { ChatMessage } from "../../../types.js";
import { EMPTY_TRANSCRIPT_STATE } from "../transcript-types.js";
import type { AssistantItem, ToolItem, ToolStatus, TranscriptItem, UserItem } from "../transcript-types.js";
import { HydrateResult } from "./classic-transcript.js";

function argsDisplayFromToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  if (!args || typeof args !== "object") return "";
  try {
    return formatToolArgs({ name, args });
  } catch {
    try {
      const json = JSON.stringify(args);
      if (json.length <= 80) return json;
      return `${json.slice(0, 77)}…`;
    } catch {
      return "";
    }
  }
}

export function fileChangesFromToolArgs(
  name: string,
  args: Record<string, unknown> | undefined,
): FileChange[] | undefined {
  if (!args || !isFileMutationTool(name)) return undefined;
  try {
    if (name === "fs.write" || name === "fs.append") {
      const path = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!path) return undefined;
      return [
        buildFileChange({
          path,
          before: "",
          after: content,
          kind: name === "fs.append" ? "append" : "create",
        }),
      ];
    }
    if (name === "fs.writeMany") {
      const files = Array.isArray(args.files) ? args.files : [];
      const changes: FileChange[] = [];
      for (const entry of files) {
        if (!entry || typeof entry !== "object") continue;
        const rec = entry as Record<string, unknown>;
        const path = String(rec.path ?? "");
        const content = String(rec.content ?? "");
        if (!path) continue;
        changes.push(
          buildFileChange({
            path,
            before: "",
            after: content,
            kind: "create",
          }),
        );
      }
      return changes.length > 0 ? changes : undefined;
    }
    if (name === "fs.edit" || name === "fs.replaceLines") {
      const path = String(args.path ?? "");
      if (!path) return undefined;
      const oldText = String(args.oldText ?? args.old ?? "");
      const newText = String(
        args.newText ?? args.new ?? args.content ?? "",
      );
      return [
        buildFileChange({
          path,
          before: oldText,
          after: newText,
          kind: "edit",
        }),
      ];
    }
    if (name === "fs.delete") {
      const path = String(args.path ?? "");
      if (!path) return undefined;
      return [
        buildFileChange({
          path,
          before: "",
          after: "",
          kind: "delete",
        }),
      ];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function enrichToolsFromMessages(
  classic: HydrateResult,
  messages: readonly ChatMessage[],
): HydrateResult {
  const byCallId = new Map<
    string,
    { name: string; args: Record<string, unknown> }
  >();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!call.id) continue;
      byCallId.set(call.id, {
        name: call.name || "tool",
        args: (call.args ?? {}) as Record<string, unknown>,
      });
    }
  }
  if (byCallId.size === 0) return classic;

  let changed = false;
  const byId = new Map(classic.state.byId);
  for (const [id, item] of byId) {
    if (item.kind !== "tool") continue;
    if (item.fileChanges && item.fileChanges.length > 0) continue;
    const call =
      byCallId.get(String(item.toolCallId)) ?? byCallId.get(item.id);
    if (!call) continue;
    const fileChanges = fileChangesFromToolArgs(call.name, call.args);
    if (!fileChanges?.length && !isFileMutationTool(call.name)) continue;
    const argsDisplay =
      item.argsDisplay &&
      !item.argsDisplay.trimStart().startsWith("{")
        ? item.argsDisplay
        : argsDisplayFromToolCall(call.name, call.args);
    byId.set(id, {
      ...item,
      name: item.name || call.name,
      argsDisplay: argsDisplay || item.argsDisplay,
      ...(fileChanges ? { fileChanges } : {}),
    });
    changed = true;
  }
  if (!changed) return classic;
  return {
    ...classic,
    state: { ...classic.state, byId },
  };
}

export function hydrateFromMessages(messages: readonly ChatMessage[]): HydrateResult {
  const order: string[] = [];
  const byId = new Map<string, TranscriptItem>();
  const toolOutputs = new Map<ToolCallId, string>();
  let sequence = 0;

  const toolResultsById = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      toolResultsById.set(message.toolCallId, message);
    }
  }

  for (const message of messages) {
    if (message.role === "system" || message.role === "tool") continue;

    if (message.role === "user") {
      if (isInternalChatMessage(message)) continue;
      sequence += 1;
      const id = `hist-user-${sequence}`;
      const item: UserItem = {
        id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "user",
        text: message.content,
      };
      byId.set(id, item);
      order.push(id);
      continue;
    }

    if (message.content.trim()) {
      sequence += 1;
      const id = `hist-asst-${sequence}`;
      const item: AssistantItem = {
        id,
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "assistant",
        text: message.content,
        streaming: false,
      };
      byId.set(id, item);
      order.push(id);
    }

    const calls = message.toolCalls;
    if (!calls?.length) continue;
    for (const call of calls) {
      sequence += 1;
      const toolCallId = asToolCallId(call.id || `hist-tool-${sequence}`);
      const result = toolResultsById.get(call.id);
      const output = result?.content ?? "";
      if (output) toolOutputs.set(toolCallId, output);
      const ok = result?.ok !== false;
      const toolName = call.name || result?.name || "tool";
      const status: ToolStatus = result ? (ok ? "ok" : "failed") : "ok";
      if (shouldHideQuietMetaToolInChat(toolName, status)) continue;
      const callArgs = (call.args ?? {}) as Record<string, unknown>;
      const fileChanges = fileChangesFromToolArgs(toolName, callArgs);
      const item: ToolItem = {
        id: String(toolCallId),
        sequence,
        turnId: undefined,
        timestamp: sequence,
        kind: "tool",
        toolCallId,
        name: toolName,
        argsDisplay: argsDisplayFromToolCall(toolName, callArgs),
        status,
        exitCode: result ? (ok ? 0 : 1) : undefined,
        summary: undefined,
        artifactPath: undefined,
        reason: undefined,
        outputBytes: Buffer.byteLength(output, "utf8"),
        fileChanges,
      };
      byId.set(item.id, item);
      order.push(item.id);
    }
  }

  return {
    state: {
      ...EMPTY_TRANSCRIPT_STATE,
      order,
      byId,
      lastSequence: 0,
    },
    toolOutputs,
  };
}
