import type {
  ChatMessage,
  NativeToolCall,
  ReasoningArtifact,
  ReasoningBlock,
} from "../types.js";
import {
  legacyReasoningBlockFromArtifacts,
  rebindReasoningArtifactsToToolCalls,
  reasoningArtifactsForPersistence,
} from "../llm/reasoning-artifacts.js";
import { syntheticToolCallId } from "../llm/tool-protocol.js";
import { slimToolArgs } from "./message-slim.js";
import { isSessionStateMessage } from "./session-state.js";
import {
  isActiveSkillsMessage,
  isAgentInstructionsMessage,
} from "./injected-blocks.js";

function isBenignTrailingSystemBlock(content: string): boolean {
  return (
    isSessionStateMessage(content) ||
    isAgentInstructionsMessage(content) ||
    isActiveSkillsMessage(content)
  );
}

function nextUniqueToolCallId(index: number, seen: Set<string>): string {
  let id = syntheticToolCallId(index);
  while (seen.has(id)) id = syntheticToolCallId(index);
  return id;
}

export function toolCallIdsInHistory(
  messages: readonly ChatMessage[],
): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !message.toolCalls?.length) continue;
    for (const call of message.toolCalls) {
      const id = typeof call.id === "string" ? call.id.trim() : "";
      if (id) ids.add(id);
    }
  }
  return ids;
}

export function ensureUniqueToolCallIds(
  calls: readonly NativeToolCall[],
  reservedIds: ReadonlySet<string> = new Set<string>(),
): NativeToolCall[] {
  const seen = new Set(
    [...reservedIds]
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return calls.map((tc, index) => {
    let id = typeof tc.id === "string" ? tc.id.trim() : "";
    if (!id || seen.has(id)) id = nextUniqueToolCallId(index, seen);
    seen.add(id);
    return id === tc.id ? tc : { ...tc, id };
  });
}

function rewriteConflictingToolCallIds(messages: ChatMessage[]): number {
  const reserved = new Set<string>();
  let bindings = new Map<string, Array<{ id: string; name: string }>>();
  let groupOpen = false;
  let repairs = 0;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.toolCalls?.length) {
      bindings = new Map();
      groupOpen = true;
      const fixed = ensureUniqueToolCallIds(message.toolCalls, reserved);
      for (let callIndex = 0; callIndex < message.toolCalls.length; callIndex += 1) {
        const original = message.toolCalls[callIndex]!;
        const replacement = fixed[callIndex]!;
        const originalId = typeof original.id === "string" ? original.id : "";
        const queue = bindings.get(originalId) ?? [];
        queue.push({ id: replacement.id, name: replacement.name });
        bindings.set(originalId, queue);
        reserved.add(replacement.id);
        if (replacement.id !== original.id) repairs += 1;
      }
      if (fixed.some((call, callIndex) => call !== message.toolCalls![callIndex])) {
        messages[index] = { ...message, toolCalls: fixed };
      }
      continue;
    }

    if (message.role === "tool" && groupOpen) {
      const originalId = message.toolCallId ?? "";
      const queue = bindings.get(originalId);
      if (queue?.length) {
        const namedIndex = message.name
          ? queue.findIndex((binding) => binding.name === message.name)
          : -1;
        const [binding] = queue.splice(namedIndex >= 0 ? namedIndex : 0, 1);
        if (binding && binding.id !== originalId) {
          messages[index] = { ...message, toolCallId: binding.id };
          repairs += 1;
        }
      }
      continue;
    }

    if (
      groupOpen &&
      message.role === "system" &&
      typeof message.content === "string" &&
      isBenignTrailingSystemBlock(message.content)
    ) {
      continue;
    }

    groupOpen = false;
    bindings = new Map();
  }

  return repairs;
}

export function slimNativeToolCallsForHistory(
  toolCalls: readonly NativeToolCall[],
): NativeToolCall[] {
  return toolCalls.map((tc) => {
    const args = slimToolArgs(tc.args ?? {});
    const { rawArguments: _rawArguments, ...durable } = tc;
    return {
      ...durable,
      args,
      ...(args._parseError && tc.rawArguments
        ? { rawArguments: tc.rawArguments }
        : {}),
    };
  });
}

export function appendAssistantWithTools(
  messages: ChatMessage[],
  text: string,
  toolCalls: NativeToolCall[],
  reasoningBlock?: ReasoningBlock | undefined,
  reasoningArtifacts?: readonly ReasoningArtifact[] | undefined,
): void {
  const durableCalls = slimNativeToolCallsForHistory(toolCalls);
  const reboundArtifacts = rebindReasoningArtifactsToToolCalls({
    artifacts: reasoningArtifacts,
    toolCalls: durableCalls,
  });
  const persistedArtifacts = reasoningArtifactsForPersistence({
    artifacts: reboundArtifacts,
    hasToolCalls: durableCalls.length > 0,
  });
  const durableReasoningBlock =
    reasoningBlock ??
    (persistedArtifacts
      ? legacyReasoningBlockFromArtifacts(persistedArtifacts)
      : undefined);
  messages.push({
    role: "assistant",
    content: text ?? "",
    ...(durableCalls.length ? { toolCalls: durableCalls } : {}),
    ...(durableReasoningBlock?.text || durableReasoningBlock?.items?.length
      ? { reasoningBlock: durableReasoningBlock }
      : {}),
    ...(persistedArtifacts ? { reasoningArtifacts: persistedArtifacts } : {}),
  });
}

export function appendToolResult(
  messages: ChatMessage[],
  toolCallId: string,
  content: string,
  name?: string,
  ok?: boolean,
): void {
  messages.push({
    role: "tool",
    content,
    toolCallId,
    ...(name ? { name } : {}),
    ...(typeof ok === "boolean" ? { ok } : {}),
  });
}

export function hasOrphanToolMessages(messages: ChatMessage[]): boolean {
  const openIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) openIds.add(tc.id);
    }
    if (msg.role === "tool") {
      const id = msg.toolCallId ?? "";
      if (!id || !openIds.has(id)) return true;
    }
  }
  return false;
}

export function missingToolResultIds(messages: ChatMessage[]): string[] {
  let lastAssistant: ChatMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolCalls?.length) {
      lastAssistant = m;
      break;
    }
  }
  if (!lastAssistant?.toolCalls?.length) return [];

  const needed = new Set(lastAssistant.toolCalls.map((tc) => tc.id));
  const start = messages.lastIndexOf(lastAssistant);
  for (let i = start + 1; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role === "tool" && m.toolCallId) needed.delete(m.toolCallId);
    if (m.role !== "tool") break;
  }
  return [...needed];
}

export function fillMissingToolResults(
  messages: ChatMessage[],
  toolCalls: NativeToolCall[],
  reason = "Cancelled — not executed this turn.",
): number {
  if (!toolCalls.length) return 0;
  const have = new Set<string>();
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (
      m.role === "assistant" &&
      m.toolCalls?.some((tc) => toolCalls.some((t) => t.id === tc.id))
    ) {
      start = i;
      break;
    }
  }
  if (start < 0) return 0;
  for (let i = start + 1; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role === "tool" && m.toolCallId) have.add(m.toolCallId);
    else if (m.role !== "tool") break;
  }

  let filled = 0;
  for (const tc of toolCalls) {
    if (have.has(tc.id)) continue;
    appendToolResult(
      messages,
      tc.id,
      `Tool ${tc.name} result (exit=130, ok=false):\n${reason}`,
      tc.name,
      false,
    );
    have.add(tc.id);
    filled += 1;
  }
  return filled;
}

export function allToolCallsHaveResults(messages: ChatMessage[]): boolean {
  const pending = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      for (const tc of msg.toolCalls) pending.add(tc.id);
    }
    if (msg.role === "tool" && msg.toolCallId) {
      pending.delete(msg.toolCallId);
    }
  }
  return pending.size === 0;
}

export function expandKeepStartForToolPairs(
  messages: ChatMessage[],
  keepStart: number,
): number {
  let start = keepStart;
  while (start > 0 && messages[start]?.role === "tool") {
    start -= 1;
  }
  if (
    start > 0 &&
    messages[start]?.role === "assistant" &&
    messages[start]!.toolCalls?.length
  ) {
  } else if (start > 0) {
    while (
      start > 0 &&
      messages[start - 1]?.role !== "system" &&
      (messages[start]?.role === "tool" ||
        (messages[start - 1]?.role === "assistant" &&
          messages[start - 1]!.toolCalls?.length &&
          messages[start]?.role === "tool"))
    ) {
      if (
        messages[start - 1]?.role === "assistant" &&
        messages[start - 1]!.toolCalls?.length
      ) {
        start -= 1;
        break;
      }
      start -= 1;
    }
  }
  return Math.max(0, start);
}

export function validateToolProtocol(messages: readonly ChatMessage[]): string[] {
  const issues: string[] = [];
  const seenIds = new Set<string>();
  let pending = new Set<string>();

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (pending.size > 0) {
        issues.push(`message ${index}: new assistant tool group before results for ${[...pending].join(", ")}`);
      }
      pending = new Set<string>();
      for (const call of message.toolCalls) {
        if (!call.id) issues.push(`message ${index}: tool call has no id`);
        if (seenIds.has(call.id)) issues.push(`message ${index}: duplicate tool call id ${call.id}`);
        seenIds.add(call.id);
        pending.add(call.id);
      }
      continue;
    }
    if (message.role === "tool") {
      const id = message.toolCallId ?? "";
      if (!id || !pending.has(id)) {
        issues.push(`message ${index}: orphan tool result${id ? ` ${id}` : ""}`);
      } else {
        pending.delete(id);
      }
      continue;
    }
    if (pending.size > 0) {
      issues.push(`message ${index}: non-tool message before results for ${[...pending].join(", ")}`);
      pending.clear();
    }
  }
  if (pending.size > 0) issues.push(`end of history: missing results for ${[...pending].join(", ")}`);
  return issues;
}

export function assertValidToolProtocol(messages: readonly ChatMessage[]): void {
  const issues = validateToolProtocol(messages);
  if (issues.length > 0) throw new Error(`invalid native tool protocol: ${issues.join("; ")}`);
}

export const PROTOCOL_PLACEHOLDER_MARKER = "[context-note]";

export function formatProtocolPlaceholder(name: string, id: string): string {
  return (
    `${PROTOCOL_PLACEHOLDER_MARKER} No stored body for ${name} (${id}) in earlier context. ` +
    `Prefer any live ${name} result later in the transcript. ` +
    `Re-call only if you still need that data.`
  );
}

export function repairToolProtocol(messages: ChatMessage[]): number {
  if (messages.length === 0) return 0;
  const idRepairs = rewriteConflictingToolCallIds(messages);
  if (validateToolProtocol(messages).length === 0) return idRepairs;

  const out: ChatMessage[] = [];
  let repairs = idRepairs;
  let pending = new Map<string, string | undefined>();
  let parkedBenignSystem: ChatMessage[] = [];

  const flushParkedBenign = (): void => {
    if (parkedBenignSystem.length === 0) return;
    out.push(...parkedBenignSystem);
    parkedBenignSystem = [];
  };

  const flushPending = (_reason: string): void => {
    for (const [id, name] of pending) {
      out.push({
        role: "tool",
        content: formatProtocolPlaceholder(name ?? "tool", id),
        toolCallId: id,
        ...(name ? { name } : {}),
        ok: true,
      });
      repairs += 1;
    }
    pending = new Map();
    flushParkedBenign();
  };

  for (const message of messages) {
    if (message.role === "assistant" && message.toolCalls?.length) {
      if (pending.size > 0) {
        flushPending("Interrupted — later assistant tool group started without results.");
      } else {
        flushParkedBenign();
      }
      out.push(message);
      pending = new Map();
      for (const call of message.toolCalls) {
        if (!call.id) {
          repairs += 1;
          continue;
        }
        pending.set(call.id, call.name);
      }
      continue;
    }

    if (message.role === "tool") {
      const id = message.toolCallId ?? "";
      if (!id || !pending.has(id)) {
        repairs += 1;
        continue;
      }
      pending.delete(id);
      out.push(message);
      if (pending.size === 0) flushParkedBenign();
      continue;
    }

    if (
      pending.size > 0 &&
      message.role === "system" &&
      typeof message.content === "string" &&
      isBenignTrailingSystemBlock(message.content)
    ) {
      parkedBenignSystem.push(message);
      repairs += 1;
      continue;
    }

    if (pending.size > 0) {
      flushPending(
        "Interrupted — conversation continued before tool results arrived (repaired).",
      );
    } else {
      flushParkedBenign();
    }
    out.push(message);
  }

  if (pending.size > 0) {
    flushPending("Missing tool result at end of history (repaired).");
  } else {
    flushParkedBenign();
  }

  if (repairs === 0 && out.length === messages.length) {
    if (validateToolProtocol(out).length === 0) return 0;
  }

  messages.length = 0;
  messages.push(...out);
  const still = validateToolProtocol(messages);
  if (still.length > 0) {
    const cleaned: ChatMessage[] = [];
    let open: Set<string> | undefined;
    for (const m of messages) {
      if (m.role === "assistant" && m.toolCalls?.length) {
        open = new Set(m.toolCalls.map((t) => t.id).filter(Boolean));
        cleaned.push(m);
        continue;
      }
      if (m.role === "tool") {
        const id = m.toolCallId ?? "";
        if (open?.has(id)) {
          open.delete(id);
          cleaned.push(m);
          if (open.size === 0) open = undefined;
        } else {
          repairs += 1;
        }
        continue;
      }
      if (open && open.size > 0) {
        const lastAsst = [...cleaned].reverse().find((x) => x.role === "assistant");
        if (lastAsst && lastAsst.toolCalls?.length) {
          const satisfied = new Set(
            cleaned
              .slice(cleaned.lastIndexOf(lastAsst) + 1)
              .filter((x) => x.role === "tool")
              .map((x) => x.toolCallId),
          );
          const remaining = lastAsst.toolCalls.filter((t) => !satisfied.has(t.id));
          for (const tc of remaining) {
            cleaned.push({
              role: "tool",
              content: formatProtocolPlaceholder(tc.name, tc.id),
              toolCallId: tc.id,
              name: tc.name,
              ok: true,
            });
            repairs += 1;
          }
        }
        open = undefined;
      }
      cleaned.push(m);
    }
    if (open && open.size > 0) {
      const lastAsst = [...cleaned].reverse().find((x) => x.role === "assistant" && x.toolCalls?.length);
      if (lastAsst?.toolCalls) {
        for (const tc of lastAsst.toolCalls) {
          if (!open.has(tc.id)) continue;
          cleaned.push({
            role: "tool",
            content: formatProtocolPlaceholder(tc.name, tc.id),
            toolCallId: tc.id,
            name: tc.name,
            ok: true,
          });
          repairs += 1;
        }
      }
    }
    messages.length = 0;
    messages.push(...cleaned);
  }

  return repairs;
}
