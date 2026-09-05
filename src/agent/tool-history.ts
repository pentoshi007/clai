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
import {
  SLIM_ARG_ABSOLUTE_MAX_CHARS,
  stripSupersededElidedArgs,
} from "./message-slim.js";
import {
  collapseElidedToolHistory,
  collapseOversizedToolHistory,
  MAX_RETAINED_COMPLETED_TOOL_ARGUMENT_CHARS,
  normalizeToolHistoryEntries,
  parseCanonicalTextToolCalls,
  PROTOCOL_PLACEHOLDER_MARKER,
} from "./tool-history-projection.js";
import { isSessionStateMessage } from "./session-state.js";
import {
  ACTIVE_SKILLS_PREFIX,
  AGENT_INSTRUCTIONS_PREFIX,
  isKeyedBlockMessage,
} from "./injected-blocks.js";

export {
  MAX_RETAINED_COMPLETED_TOOL_ARGUMENT_CHARS,
  PROTOCOL_PLACEHOLDER_MARKER,
};

function isBenignTrailingSystemBlock(content: string): boolean {
  return (
    isSessionStateMessage(content) ||
    isKeyedBlockMessage(content, AGENT_INSTRUCTIONS_PREFIX) ||
    isKeyedBlockMessage(content, ACTIVE_SKILLS_PREFIX)
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

function copyToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(args);
  } catch {
    return { ...args };
  }
}

export function slimNativeToolCallsForHistory(
  toolCalls: readonly NativeToolCall[],
): NativeToolCall[] {
  return toolCalls.map((tc) => {
    const args = copyToolArgs(stripSupersededElidedArgs(tc.args ?? {}));
    const { rawArguments: _rawArguments, ...durable } = tc;
    return {
      ...durable,
      args,
      ...(args._parseError &&
      tc.rawArguments &&
      tc.rawArguments.length <= SLIM_ARG_ABSOLUTE_MAX_CHARS
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
  let pendingTextResults = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      pendingTextResults = message.toolCalls?.length
        ? 0
        : parseCanonicalTextToolCalls(message.content).length;
      for (const call of message.toolCalls ?? []) openIds.add(call.id);
      continue;
    }
    if (message.role === "tool") {
      const id = message.toolCallId ?? "";
      if (id) {
        if (!openIds.has(id)) return true;
        openIds.delete(id);
      } else {
        if (pendingTextResults <= 0) return true;
        pendingTextResults -= 1;
      }
      continue;
    }
    pendingTextResults = 0;
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
  let pendingTextCalls: NativeToolCall[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    const textCalls =
      message.role === "assistant" && !message.toolCalls?.length
        ? parseCanonicalTextToolCalls(message.content)
        : [];
    if (
      message.role === "assistant" &&
      (message.toolCalls?.length || textCalls.length > 0)
    ) {
      if (pending.size > 0 || pendingTextCalls.length > 0) {
        const open = [
          ...pending,
          ...pendingTextCalls.map((call) => call.name),
        ];
        issues.push(`message ${index}: new assistant tool group before results for ${open.join(", ")}`);
      }
      pending = new Set<string>();
      pendingTextCalls = [];
      if (message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          if (!call.id) issues.push(`message ${index}: tool call has no id`);
          if (seenIds.has(call.id)) issues.push(`message ${index}: duplicate tool call id ${call.id}`);
          seenIds.add(call.id);
          pending.add(call.id);
        }
      } else {
        pendingTextCalls = textCalls;
      }
      continue;
    }
    if (message.role === "tool") {
      const id = message.toolCallId ?? "";
      if (id && pending.has(id)) {
        pending.delete(id);
      } else if (!id && pendingTextCalls.length > 0) {
        pendingTextCalls.shift();
      } else {
        issues.push(`message ${index}: orphan tool result${id ? ` ${id}` : ""}`);
      }
      continue;
    }
    if (pending.size > 0 || pendingTextCalls.length > 0) {
      const open = [
        ...pending,
        ...pendingTextCalls.map((call) => call.name),
      ];
      issues.push(`message ${index}: non-tool message before results for ${open.join(", ")}`);
      pending.clear();
      pendingTextCalls = [];
    }
  }
  if (pending.size > 0 || pendingTextCalls.length > 0) {
    const open = [
      ...pending,
      ...pendingTextCalls.map((call) => call.name),
    ];
    issues.push(`end of history: missing results for ${open.join(", ")}`);
  }
  return issues;
}

export function assertValidToolProtocol(messages: readonly ChatMessage[]): void {
  const issues = validateToolProtocol(messages);
  if (issues.length > 0) throw new Error(`invalid native tool protocol: ${issues.join("; ")}`);
}

export function formatProtocolPlaceholder(name: string, id: string): string {
  return (
    `${PROTOCOL_PLACEHOLDER_MARKER} No stored body for ${name} (${id}) in earlier context. ` +
    `Prefer any live ${name} result later in the transcript. ` +
    `Re-call only if you still need that data.`
  );
}

export function repairToolProtocol(messages: ChatMessage[]): number {
  if (messages.length === 0) return 0;
  let repairs = normalizeToolHistoryEntries(messages);
  const idRepairs = rewriteConflictingToolCallIds(messages);
  repairs += idRepairs;
  repairs += collapseOversizedToolHistory(messages);
  if (validateToolProtocol(messages).length === 0) {
    return (
      repairs +
      collapseElidedToolHistory(messages) +
      collapseOversizedToolHistory(messages)
    );
  }

  const out: ChatMessage[] = [];
  let pending = new Map<string, string | undefined>();
  let pendingTextCalls: NativeToolCall[] = [];
  let parkedBenignSystem: ChatMessage[] = [];

  const hasPending = (): boolean =>
    pending.size > 0 || pendingTextCalls.length > 0;

  const flushParkedBenign = (): void => {
    if (parkedBenignSystem.length === 0) return;
    out.push(...parkedBenignSystem);
    parkedBenignSystem = [];
  };

  const flushPending = (): void => {
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
    for (const call of pendingTextCalls) {
      out.push({
        role: "tool",
        content: formatProtocolPlaceholder(call.name, call.id),
        name: call.name,
        ok: true,
      });
      repairs += 1;
    }
    pending = new Map();
    pendingTextCalls = [];
    flushParkedBenign();
  };

  for (const message of messages) {
    const textCalls =
      message.role === "assistant" && !message.toolCalls?.length
        ? parseCanonicalTextToolCalls(message.content)
        : [];
    if (
      message.role === "assistant" &&
      (message.toolCalls?.length || textCalls.length > 0)
    ) {
      if (hasPending()) flushPending();
      else flushParkedBenign();
      out.push(message);
      pending = new Map();
      pendingTextCalls = [];
      if (message.toolCalls?.length) {
        for (const call of message.toolCalls) {
          if (!call.id) {
            repairs += 1;
            continue;
          }
          pending.set(call.id, call.name);
        }
      } else {
        pendingTextCalls = textCalls;
      }
      continue;
    }

    if (message.role === "tool") {
      const id = message.toolCallId ?? "";
      if (id && pending.has(id)) {
        pending.delete(id);
        out.push(message);
      } else if (!id && pendingTextCalls.length > 0) {
        pendingTextCalls.shift();
        out.push(message);
      } else {
        repairs += 1;
        continue;
      }
      if (!hasPending()) flushParkedBenign();
      continue;
    }

    if (
      hasPending() &&
      message.role === "system" &&
      typeof message.content === "string" &&
      isBenignTrailingSystemBlock(message.content)
    ) {
      parkedBenignSystem.push(message);
      repairs += 1;
      continue;
    }

    if (hasPending()) flushPending();
    else flushParkedBenign();
    out.push(message);
  }

  if (hasPending()) flushPending();
  else flushParkedBenign();

  messages.length = 0;
  messages.push(...out);

  return (
    repairs +
    collapseElidedToolHistory(messages) +
    collapseOversizedToolHistory(messages)
  );
}

export function projectToolHistory(
  messages: readonly ChatMessage[],
): { messages: ChatMessage[]; changed: boolean; repairs: number } {
  const copy = messages.map((message) => {
    try {
      return structuredClone(message);
    } catch {
      return { ...message };
    }
  });
  const repairs = repairToolProtocol(copy);
  return {
    messages: repairs > 0 ? copy : [...messages],
    changed: repairs > 0,
    repairs,
  };
}
