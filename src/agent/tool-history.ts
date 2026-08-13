import type { ChatMessage, NativeToolCall, ReasoningBlock } from "../types.js";
import { syntheticToolCallId } from "../llm/tool-protocol.js";
import { slimToolArgs } from "./message-slim.js";
import { isSessionStateMessage } from "./session-state.js";

function nextUniqueToolCallId(index: number, seen: Set<string>): string {
  let id = syntheticToolCallId(index);
  while (seen.has(id)) id = syntheticToolCallId(index);
  return id;
}

/** All non-empty native tool-call ids already reserved by a transcript. */
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

/**
 * Ensure every tool call has a unique non-empty id before history append.
 * `reservedIds` closes the provider-reuse case: some gateways reuse ids across
 * separate assistant turns even though the wire protocol requires transcript-
 * wide uniqueness.
 */
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

/**
 * Chronologically rebind later duplicate/empty call ids and only the tool rows
 * belonging to that assistant group. This makes already-persisted poisoned
 * histories resumable without dropping successful tool bodies.
 */
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
      isSessionStateMessage(message.content)
    ) {
      continue;
    }

    groupOpen = false;
    bindings = new Map();
  }

  return repairs;
}

/**
 * History copy of toolCalls: slim large write payloads so RAM and API
 * re-sends do not retain full file bodies (tools already ran from live args).
 */
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

/** Append assistant turn that requested tools (must precede tool results). */
export function appendAssistantWithTools(
  messages: ChatMessage[],
  text: string,
  toolCalls: NativeToolCall[],
  /**
   * Signed reasoning that must be replayed with this turn. Anthropic
   * rejects a tool_use turn whose thinking block is missing once extended
   * thinking is on; other dialects ignore the field.
   */
  reasoningBlock?: ReasoningBlock | undefined,
): void {
  messages.push({
    role: "assistant",
    content: text ?? "",
    ...(toolCalls.length
      ? { toolCalls: slimNativeToolCallsForHistory(toolCalls) }
      : {}),
    ...(reasoningBlock?.text || reasoningBlock?.items?.length
      ? { reasoningBlock }
      : {}),
  });
}

/** Append a single tool result linked by tool_call_id. */
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

/**
 * Whether the message list would orphan a tool result (result without a
 * preceding assistant toolCalls entry that owns the id).
 */
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

/** Ids on the last assistant toolCalls message that lack a following tool result. */
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
  // Only scan results after that assistant message.
  const start = messages.lastIndexOf(lastAssistant);
  for (let i = start + 1; i < messages.length; i += 1) {
    const m = messages[i]!;
    if (m.role === "tool" && m.toolCallId) needed.delete(m.toolCallId);
    // Stop at next non-tool (next turn).
    if (m.role !== "tool") break;
  }
  return [...needed];
}

/**
 * Append synthetic failed tool results for any assistant toolCalls ids that
 * still lack a role:tool reply (deferred, cancelled, sliced, abort).
 */
export function fillMissingToolResults(
  messages: ChatMessage[],
  toolCalls: NativeToolCall[],
  reason = "Cancelled — not executed this turn.",
): number {
  if (!toolCalls.length) return 0;
  const have = new Set<string>();
  // Collect existing tool results after the last matching assistant.
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

/**
 * True when every id on every assistant toolCalls has a matching tool result
 * later in the list (no missing pairs). Used by tests and diagnostics.
 */
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

/**
 * When compacting, never leave role:tool without its assistant toolCalls.
 * Expand a keep-window start so tool pairs stay intact.
 */
export function expandKeepStartForToolPairs(
  messages: ChatMessage[],
  keepStart: number,
): number {
  let start = keepStart;
  while (start > 0 && messages[start]?.role === "tool") {
    start -= 1;
  }
  // If we landed mid-assistant-with-tools, include that assistant.
  if (
    start > 0 &&
    messages[start]?.role === "assistant" &&
    messages[start]!.toolCalls?.length
  ) {
    // already includes assistant
  } else if (start > 0) {
    // If first kept message is tool, walk back to assistant
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

/**
 * Validate native assistant/tool groups immediately before provider dispatch.
 * Every tool result must belong to the currently open assistant group, ids are
 * unique, and no non-tool message may begin until the whole group is closed.
 */
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

/**
 * Marker prefix for history-repair tool bodies. Detected by
 * {@link isProtocolPlaceholderOutput} so governors do not treat these as live work.
 * Keep stable; change wording below freely.
 */
export const PROTOCOL_PLACEHOLDER_MARKER = "[context-note]";

/**
 * Neutral pairing placeholder when a tool result is missing from history.
 *
 * Must stay boring: no "synthetic", "closure", "interrupted", "after resume",
 * "exit=130", "history-repair", or "tools are broken" — those phrases make
 * models invent "platform artifact" stories and re-run tools that already
 * succeeded in the live transcript.
 */
export function formatProtocolPlaceholder(name: string, id: string): string {
  return (
    `${PROTOCOL_PLACEHOLDER_MARKER} No stored body for ${name} (${id}) in earlier context. ` +
    `Prefer any live ${name} result later in the transcript. ` +
    `Re-call only if you still need that data.`
  );
}

/**
 * Heal broken assistant/tool pairing so a resume ("continue") never dies on
 * `invalid native tool protocol` after a mid-turn abort, partial stream, or
 * corrupted history reload.
 *
 * - Missing tool results for open assistant toolCalls → quiet ok placeholders
 * - Orphan tool results (no open call id) → dropped
 * - Non-tool message while results pending → close the group first
 *
 * Mutates `messages` in place when repairs are needed. Returns repair count.
 */
export function repairToolProtocol(messages: ChatMessage[]): number {
  if (messages.length === 0) return 0;
  const idRepairs = rewriteConflictingToolCallIds(messages);
  if (validateToolProtocol(messages).length === 0) return idRepairs;

  const out: ChatMessage[] = [];
  let repairs = idRepairs;
  /** Open tool call ids → name (best-effort). */
  let pending = new Map<string, string | undefined>();
  /**
   * Benign system rows (SESSION STATE) that landed mid tool-group. Park them
   * and re-append after the group closes so real tool bodies are not dropped.
   */
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
        // Orphan result — drop so providers don't reject the history.
        repairs += 1;
        continue;
      }
      pending.delete(id);
      out.push(message);
      if (pending.size === 0) flushParkedBenign();
      continue;
    }

    // SESSION STATE (and similar) must never close an open tool group —
    // that path replaced live tool bodies with "No stored body" placeholders.
    if (
      pending.size > 0 &&
      message.role === "system" &&
      typeof message.content === "string" &&
      isSessionStateMessage(message.content)
    ) {
      parkedBenignSystem.push(message);
      repairs += 1; // reordered relative to the broken history
      continue;
    }

    // user / system / plain assistant — must not interrupt an open tool group.
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
    // Structure same length but still invalid (e.g. duplicate ids) — fall through rebuild.
    if (validateToolProtocol(out).length === 0) return 0;
  }

  messages.length = 0;
  messages.push(...out);
  // Second pass: if still broken (duplicate ids), strip toolCalls from broken assistants.
  const still = validateToolProtocol(messages);
  if (still.length > 0) {
    // Last resort: drop toolCalls arrays that never got clean results, keep text.
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
        // Convert incomplete assistant to plain text by clearing remaining opens via flush already done;
        // if still open, strip the assistant's toolCalls and drop dangling.
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
