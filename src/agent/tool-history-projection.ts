import { createHash } from "node:crypto";

import type {
  ChatMessage,
  NativeToolCall,
  ReasoningArtifact,
} from "../types.js";
import {
  createReasoningArtifact,
  legacyReasoningBlockFromArtifacts,
  rebindReasoningArtifactsToToolCalls,
  reasoningArtifactsForMessage,
  reasoningArtifactsForPersistence,
} from "../llm/reasoning-artifacts.js";
import {
  containsElidedStubText,
  findElidedStubArg,
  measureToolCallsChars,
  stripSupersededElidedArgs,
} from "./message-slim.js";

export const MAX_RETAINED_COMPLETED_TOOL_ARGUMENT_CHARS = 256 * 1024;
export const PROTOCOL_PLACEHOLDER_MARKER = "[context-note]";

const CANONICAL_TOOL_FENCE_PATTERN = /```tool\s*\n?([\s\S]*?)```/gi;
const STRICT_CANONICAL_TOOL_FENCE_PATTERN = /```tool[ \t]*\r?\n([\s\S]*?)```/gi;
const MAX_RECEIPT_VALUE_CHARS = 96;

function rawArgumentsContainElidedStub(rawArguments: string): boolean {
  if (containsElidedStubText(rawArguments)) return true;
  try {
    return Boolean(findElidedStubArg(JSON.parse(rawArguments)));
  } catch {
    return false;
  }
}

function boundedReceiptValue(value: string): string {
  if (value.length <= MAX_RECEIPT_VALUE_CHARS) {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_RECEIPT_VALUE_CHARS) return serialized;
  }
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return JSON.stringify(`«${value.length} chars sha256=${hash}»`);
}

function legacyToolName(name: string): string {
  return /^[a-z0-9_.:-]{1,96}$/i.test(name)
    ? name
    : `tool=${boundedReceiptValue(name)}`;
}

function legacyToolTarget(call: NativeToolCall): string {
  const path = call.args && typeof call.args.path === "string" ? call.args.path : "";
  if (path) return ` path=${boundedReceiptValue(path)}`;
  const sourceFiles = Array.isArray(call.args?.files)
    ? call.args.files.slice(0, 8)
    : [];
  const files = sourceFiles.flatMap((file) =>
    file && typeof file === "object" && typeof (file as { path?: unknown }).path === "string"
      ? [boundedReceiptValue((file as { path: string }).path)]
      : [],
  );
  return files.length > 0 ? ` paths=[${files.join(",")}]` : "";
}

function resultStatus(result: ChatMessage | undefined): string {
  if (!result || result.content.includes(PROTOCOL_PLACEHOLDER_MARKER)) {
    return "recorded";
  }
  return result.ok === false ? "failed" : "completed";
}

function legacyToolReceipt(
  call: NativeToolCall,
  result: ChatMessage | undefined,
): string {
  const rejectedPlaceholder = result?.content.includes("elided history placeholder") === true;
  const status = rejectedPlaceholder ? "rejected before execution" : resultStatus(result);
  const detail = rejectedPlaceholder
    ? "No tool operation ran for this rejected call. Generate new literal content only if work remains."
    : "The prior result body was removed with the legacy payload.";
  return (
    `${PROTOCOL_PLACEHOLDER_MARKER} Earlier ${legacyToolName(call.name)}${legacyToolTarget(call)} ${status}. ` +
    `Its payload was removed from legacy history and must not be replayed. ${detail}`
  );
}

function settledToolReceipt(
  calls: readonly NativeToolCall[],
  resultById: ReadonlyMap<string, ChatMessage>,
  argumentChars: number,
): string {
  const listed = calls
    .slice(0, 8)
    .map((call) => `${legacyToolName(call.name)}${legacyToolTarget(call)}=${resultStatus(resultById.get(call.id))}`)
    .join(", ");
  const overflow = calls.length > 8 ? `, +${calls.length - 8} more` : "";
  let serialized = "";
  try {
    serialized = JSON.stringify(
      calls.map((call) => ({ name: call.name, args: call.args })),
    );
  } catch {
    serialized = calls.map((call) => call.name).join("\n");
  }
  const hash = createHash("sha256").update(serialized).digest("hex").slice(0, 16);
  return (
    `${PROTOCOL_PLACEHOLDER_MARKER} Earlier settled tool interaction was compacted after execution to bound context: ` +
    `${listed}${overflow}. argument_chars=${argumentChars} sha256=${hash}. ` +
    "Re-run only if current work still requires it."
  );
}

function retainReasoningArtifactsForCalls(
  message: ChatMessage,
  retainedCalls: readonly NativeToolCall[],
): readonly ReasoningArtifact[] | undefined {
  const sourceCalls = message.toolCalls ?? [];
  const artifacts = reasoningArtifactsForMessage(message);
  if (artifacts.length === 0) return undefined;
  const retained = artifacts.flatMap((artifact) => {
    const callId = artifact.position.toolCallId;
    const callIndex = artifact.position.toolCallIndex;
    if (!callId && callIndex === undefined) return [artifact];
    const sourceCall =
      (callId ? sourceCalls.find((call) => call.id === callId) : undefined) ??
      (callIndex !== undefined ? sourceCalls[callIndex] : undefined);
    if (!sourceCall) return [];
    const retainedIndex = retainedCalls.findIndex(
      (call) => call === sourceCall || (sourceCall.id && call.id === sourceCall.id),
    );
    if (retainedIndex < 0) return [];
    const retainedCall = retainedCalls[retainedIndex]!;
    return [
      createReasoningArtifact({
        kind: artifact.kind,
        raw: artifact.raw,
        ...(artifact.displaySummary !== undefined
          ? { displaySummary: artifact.displaySummary }
          : {}),
        provenance: artifact.provenance,
        replay: artifact.replay,
        position: {
          ...artifact.position,
          toolCallId: retainedCall.id,
          toolCallIndex: retainedIndex,
        },
      }),
    ];
  });
  return retained.length > 0 ? retained : undefined;
}

function assistantWithRetainedCalls(
  message: ChatMessage,
  retainedCalls: NativeToolCall[],
  notes: readonly string[],
): ChatMessage {
  const retainedArtifacts = retainReasoningArtifactsForCalls(
    message,
    retainedCalls,
  );
  const reboundArtifacts = rebindReasoningArtifactsToToolCalls({
    artifacts: retainedArtifacts,
    toolCalls: retainedCalls,
  });
  const persistedArtifacts = reasoningArtifactsForPersistence({
    artifacts: reboundArtifacts,
    hasToolCalls: retainedCalls.length > 0,
  });
  const durableReasoningBlock = persistedArtifacts
    ? legacyReasoningBlockFromArtifacts(persistedArtifacts)
    : undefined;
  const {
    toolCalls: _toolCalls,
    reasoningBlock: _reasoningBlock,
    reasoningArtifacts: _reasoningArtifacts,
    ...base
  } = message;
  const content = [message.content.trim(), ...notes]
    .filter(Boolean)
    .join("\n\n");
  return {
    ...base,
    content,
    ...(retainedCalls.length > 0 ? { toolCalls: retainedCalls } : {}),
    ...(durableReasoningBlock ? { reasoningBlock: durableReasoningBlock } : {}),
    ...(persistedArtifacts ? { reasoningArtifacts: persistedArtifacts } : {}),
  };
}

function normalizeTextToolHistory(message: ChatMessage): {
  message: ChatMessage;
  collapseResults: boolean;
  changed: boolean;
} {
  if (message.role !== "assistant" || !message.content) {
    return { message, collapseResults: false, changed: false };
  }
  let changed = false;
  let hasStandalonePlaceholder = false;
  const rewritten = message.content.replace(
    CANONICAL_TOOL_FENCE_PATTERN,
    (block: string, raw: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.trim());
      } catch {
        return block;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return block;
      }
      const source = parsed as Record<string, unknown>;
      if (!source.args || typeof source.args !== "object" || Array.isArray(source.args)) {
        return block;
      }
      const args = source.args as Record<string, unknown>;
      const normalized = stripSupersededElidedArgs(args);
      if (findElidedStubArg(normalized)) {
        hasStandalonePlaceholder = true;
        return "";
      }
      if (normalized === args) return block;
      changed = true;
      return `\`\`\`tool\n${JSON.stringify({ ...source, args: normalized })}\n\`\`\``;
    },
  );
  if (hasStandalonePlaceholder) {
    const prose = message.content.replace(CANONICAL_TOOL_FENCE_PATTERN, "").trim();
    const safeProse = containsElidedStubText(prose) ? "" : prose;
    const content = [
      safeProse,
      `${PROTOCOL_PLACEHOLDER_MARKER} Earlier text tool calls containing a legacy elided payload were removed and must not be replayed.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return {
      message: { ...message, content },
      collapseResults: true,
      changed: true,
    };
  }
  if (containsElidedStubText(rewritten)) {
    return {
      message: {
        ...message,
        content: `${PROTOCOL_PLACEHOLDER_MARKER} Earlier assistant content containing a legacy elided payload was removed and must not be replayed.`,
      },
      collapseResults: true,
      changed: true,
    };
  }
  return {
    message: changed ? { ...message, content: rewritten } : message,
    collapseResults: false,
    changed,
  };
}

export function normalizeToolHistoryEntries(messages: ChatMessage[]): number {
  const out: ChatMessage[] = [];
  let repairs = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && message.toolCalls?.length) {
      let changed = false;
      const toolCalls = message.toolCalls.map((call) => {
        const args = stripSupersededElidedArgs(call.args ?? {});
        const rawContainsElidedStub =
          typeof call.rawArguments === "string" &&
          rawArgumentsContainElidedStub(call.rawArguments);
        if (args === call.args && !rawContainsElidedStub) return call;
        changed = true;
        repairs += 1;
        if (args._parseError === true) return { ...call, args };
        const { rawArguments: _rawArguments, ...durable } = call;
        if (!call.rawArguments) return { ...durable, args };
        try {
          return { ...durable, args, rawArguments: JSON.stringify(args) };
        } catch {
          return { ...durable, args };
        }
      });
      let content = message.content;
      if (containsElidedStubText(content)) {
        content = `${PROTOCOL_PLACEHOLDER_MARKER} Earlier assistant prose containing a legacy elided payload was removed and must not be replayed.`;
        changed = true;
        repairs += 1;
      }
      out.push(changed ? { ...message, content, toolCalls } : message);
      continue;
    }
    const normalized = normalizeTextToolHistory(message);
    out.push(normalized.message);
    if (normalized.changed) repairs += 1;
    if (normalized.collapseResults) {
      while (messages[index + 1]?.role === "tool") {
        index += 1;
        repairs += 1;
      }
    }
  }
  if (repairs > 0) {
    messages.length = 0;
    messages.push(...out);
  }
  return repairs;
}

export function collapseElidedToolHistory(messages: ChatMessage[]): number {
  const out: ChatMessage[] = [];
  let repairs = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || !message.toolCalls?.length) {
      out.push(message);
      continue;
    }
    const elided = message.toolCalls.filter(
      (call) =>
        Boolean(findElidedStubArg(call.args)) ||
        (call.args._parseError === true &&
          typeof call.rawArguments === "string" &&
          rawArgumentsContainElidedStub(call.rawArguments)),
    );
    if (elided.length === 0) {
      out.push(message);
      continue;
    }
    let resultEnd = index + 1;
    while (messages[resultEnd]?.role === "tool") resultEnd += 1;
    const resultById = new Map<string, ChatMessage>();
    for (let resultIndex = index + 1; resultIndex < resultEnd; resultIndex += 1) {
      const result = messages[resultIndex]!;
      if (result.toolCallId) resultById.set(result.toolCallId, result);
    }
    const removedIds = new Set(elided.map((call) => call.id));
    const retainedCalls = message.toolCalls.filter(
      (call) => !removedIds.has(call.id),
    );
    out.push(
      assistantWithRetainedCalls(
        message,
        retainedCalls,
        elided.map((call) => legacyToolReceipt(call, resultById.get(call.id))),
      ),
    );
    let removedResults = 0;
    for (let resultIndex = index + 1; resultIndex < resultEnd; resultIndex += 1) {
      const result = messages[resultIndex]!;
      if (!result.toolCallId || !removedIds.has(result.toolCallId)) {
        out.push(result);
      } else {
        removedResults += 1;
      }
    }
    repairs += elided.length + removedResults;
    index = resultEnd - 1;
  }
  if (repairs > 0) {
    messages.length = 0;
    messages.push(...out);
  }
  return repairs;
}

type CanonicalTextToolFence = {
  start: number;
  end: number;
  call: NativeToolCall;
};

function canonicalTextToolFences(content: string): CanonicalTextToolFence[] {
  const fences: CanonicalTextToolFence[] = [];
  for (const match of content.matchAll(STRICT_CANONICAL_TOOL_FENCE_PATTERN)) {
    const raw = match[1];
    if (raw === undefined || match.index === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.trim());
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const source = parsed as Record<string, unknown>;
    if (typeof source.name !== "string" || !source.name.trim()) continue;
    if (!source.args || typeof source.args !== "object" || Array.isArray(source.args)) {
      continue;
    }
    fences.push({
      start: match.index,
      end: match.index + match[0].length,
      call: {
        id: `text-${fences.length}`,
        name: source.name,
        args: source.args as Record<string, unknown>,
      },
    });
  }
  return fences;
}

export function parseCanonicalTextToolCalls(content: string): NativeToolCall[] {
  return canonicalTextToolFences(content).map((fence) => fence.call);
}

function removeCanonicalTextToolFences(
  content: string,
  fences: readonly CanonicalTextToolFence[],
): string {
  let cursor = 0;
  let retained = "";
  for (const fence of fences) {
    retained += content.slice(cursor, fence.start);
    cursor = fence.end;
  }
  return `${retained}${content.slice(cursor)}`.trim();
}

type CompletedToolGroup = {
  kind: "native" | "text";
  start: number;
  end: number;
  message: ChatMessage;
  calls: NativeToolCall[];
  fences?: CanonicalTextToolFence[];
  resultById: Map<string, ChatMessage>;
  argumentChars: number;
};

function completedToolGroups(messages: readonly ChatMessage[]): CompletedToolGroup[] {
  const groups: CompletedToolGroup[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    if (message.toolCalls?.length) {
      let end = index + 1;
      const resultById = new Map<string, ChatMessage>();
      while (messages[end]?.role === "tool") {
        const result = messages[end]!;
        if (result.toolCallId) resultById.set(result.toolCallId, result);
        end += 1;
      }
      if (
        message.toolCalls.every((call) => {
          const result = resultById.get(call.id);
          return (
            Boolean(call.id) &&
            Boolean(result) &&
            !result!.content.includes(PROTOCOL_PLACEHOLDER_MARKER)
          );
        })
      ) {
        groups.push({
          kind: "native",
          start: index,
          end,
          message,
          calls: message.toolCalls,
          resultById,
          argumentChars: measureToolCallsChars(message.toolCalls),
        });
      }
      index = end - 1;
      continue;
    }
    const fences = canonicalTextToolFences(message.content);
    if (fences.length === 0) continue;
    let end = index + 1;
    const resultById = new Map<string, ChatMessage>();
    while (messages[end]?.role === "tool" && !messages[end]!.toolCallId) {
      const call = fences[end - index - 1]?.call;
      if (call) resultById.set(call.id, messages[end]!);
      end += 1;
    }
    if (
      end - index - 1 !== fences.length ||
      [...resultById.values()].some((result) =>
        result.content.includes(PROTOCOL_PLACEHOLDER_MARKER),
      )
    ) {
      index = end - 1;
      continue;
    }
    const calls = fences.map((fence) => fence.call);
    groups.push({
      kind: "text",
      start: index,
      end,
      message,
      calls,
      fences,
      resultById,
      argumentChars: measureToolCallsChars(calls),
    });
    index = end - 1;
  }
  return groups;
}

export function collapseOversizedToolHistory(messages: ChatMessage[]): number {
  const groups = completedToolGroups(messages);
  const collapseStarts = new Set<number>();
  let retainedChars = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index]!;
    if (
      group.argumentChars > MAX_RETAINED_COMPLETED_TOOL_ARGUMENT_CHARS ||
      retainedChars + group.argumentChars > MAX_RETAINED_COMPLETED_TOOL_ARGUMENT_CHARS
    ) {
      collapseStarts.add(group.start);
    } else {
      retainedChars += group.argumentChars;
    }
  }
  if (collapseStarts.size === 0) return 0;
  const byStart = new Map(groups.map((group) => [group.start, group]));
  const out: ChatMessage[] = [];
  let repairs = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const group = byStart.get(index);
    if (!group || !collapseStarts.has(index)) {
      out.push(messages[index]!);
      continue;
    }
    const message =
      group.kind === "text" && group.fences
        ? {
            ...group.message,
            content: removeCanonicalTextToolFences(
              group.message.content,
              group.fences,
            ),
          }
        : group.message;
    out.push(
      assistantWithRetainedCalls(message, [], [
        settledToolReceipt(
          group.calls,
          group.resultById,
          group.argumentChars,
        ),
      ]),
    );
    repairs += group.end - group.start;
    index = group.end - 1;
  }
  messages.length = 0;
  messages.push(...out);
  return repairs;
}
