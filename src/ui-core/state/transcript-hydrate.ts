/**
 * Resume helpers: classic/history TranscriptItem + ChatMessage → v2 store shape.
 *
 * History records may carry a full TUI transcript (classic clai) or only the
 * model messages array (older / partial saves). We hydrate both so /history
 * restores prompts, tools, and assistant text — not just a notice.
 */

import { isInternalChatMessage, type ChatMessage } from "../../types.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../app/ports/transcript-item.js";
import { asToolCallId, type ToolCallId } from "../../app/events/app-event.js";
import { shouldHideQuietMetaToolInChat } from "../../app/adapters/quiet-meta-tools.js";
import { formatToolArgs } from "../../agent/tool-call-parser.js";
import {
  buildFileChange,
  isFileMutationTool,
  type FileChange,
} from "../../tools/file-diff.js";
import {
  EMPTY_TRANSCRIPT_STATE,
  type AssistantItem,
  type CompactedItem,
  type NoticeItem,
  type ThinkingItem,
  type ToolItem,
  type ToolStatus,
  type TranscriptItem,
  type TranscriptState,
  type UserItem,
} from "./transcript-types.js";

export interface HydrateResult {
  readonly state: TranscriptState;
  /** Tool outputs to seed into OutputSpool (classic embeds output on the item). */
  readonly toolOutputs: ReadonlyMap<ToolCallId, string>;
}

function mapToolStatus(status: string | undefined): ToolStatus {
  if (
    status === "ok" ||
    status === "running" ||
    status === "blocked" ||
    status === "queued"
  ) {
    return status;
  }
  if (status === "fail" || status === "failed") return "failed";
  return "ok";
}

/** Convert a classic (or mixed) saved transcript into the v2 normalized state. */
export function hydrateFromClassicTranscript(
  items: readonly ClassicTranscriptItem[],
): HydrateResult {
  const order: string[] = [];
  const byId = new Map<string, TranscriptItem>();
  const toolOutputs = new Map<ToolCallId, string>();
  let sequence = 0;

  for (const raw of items) {
    sequence += 1;
    const id = raw.id || `hist-${sequence}`;
    const base = {
      id,
      sequence,
      turnId: undefined as undefined,
      timestamp: sequence,
    };

    switch (raw.kind) {
      case "user": {
        const item: UserItem = { ...base, kind: "user", text: raw.text ?? "" };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "assistant": {
        const item: AssistantItem = {
          ...base,
          kind: "assistant",
          text: raw.text ?? "",
          streaming: false,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "thinking": {
        const item: ThinkingItem = {
          ...base,
          kind: "thinking",
          content: raw.content ?? "",
          streaming: false,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "tool": {
        const toolCallId = asToolCallId(id);
        const status = mapToolStatus(raw.status);
        const name = raw.name ?? "tool";
        const chatStatus = status === "running" ? "ok" : status;
        // Successful plan/task meta tools are Tasks-pane only (not chat).
        if (shouldHideQuietMetaToolInChat(name, chatStatus)) break;
        const output = typeof raw.output === "string" ? raw.output : "";
        if (output) toolOutputs.set(toolCallId, output);
        const rawChanges = (raw as { fileChanges?: unknown }).fileChanges;
        const item: ToolItem = {
          ...base,
          kind: "tool",
          toolCallId,
          name,
          argsDisplay: raw.argsDisplay ?? "",
          status: chatStatus,
          exitCode: raw.exitCode,
          summary: raw.summary,
          artifactPath: raw.artifactPath,
          reason: undefined,
          outputBytes: Buffer.byteLength(output, "utf8"),
          fileChanges: Array.isArray(rawChanges)
            ? (rawChanges as ToolItem["fileChanges"])
            : undefined,
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "notice":
        // Ephemeral UI chrome only — never rehydrate into the conversation
        // (would inflate item counts and reappear after every /history).
        break;
      case "compacted": {
        const item: CompactedItem = {
          ...base,
          kind: "compacted",
          summary: raw.summary ?? "Compacted context",
          beforeTokens: raw.beforeTokens ?? 0,
          afterTokens: raw.afterTokens ?? raw.beforeTokens ?? 0,
          ...(raw.error ? { error: raw.error } : {}),
        };
        byId.set(id, item);
        order.push(id);
        break;
      }
      case "plan":
        // Plans restore via plan store / Ctrl+H — skip visual plan rows.
        break;
      default:
        break;
    }
  }

  if (order.length === 0) {
    return { state: EMPTY_TRANSCRIPT_STATE, toolOutputs };
  }

  return {
    state: {
      ...EMPTY_TRANSCRIPT_STATE,
      order,
      byId,
      // Historical item.sequence is display metadata only. lastSequence must
      // stay 0 so the live EventSequencer (rebound to 0 on loadHistory) can
      // apply turn-started and the rest of the next turn — otherwise every
      // event with seq <= N is dropped and the new user prompt never appears.
      lastSequence: 0,
    },
    toolOutputs,
  };
}

/**
 * Format tool args for a compact card label when restoring from model history.
 * Prefer the same human labels live turns use (path / "N file(s)") — never dump
 * full content JSON into the card header (that is what made history look broken).
 */
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

/**
 * Rebuild structured file diffs from tool-call args so /history shows the same
 * green/red hunks as the live session. Live turns attach `fileChanges` on
 * tool-result; message-only history (or a re-save after a thin hydrate) often
 * drops that payload while still keeping path/content in `toolCalls[].args`.
 *
 * Not a cwd issue — absolute paths in the snapshot still render; missing
 * `fileChanges` is what forces the ugly receipt + JSON args UI.
 */
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
      // Snippet-level before/after still yields a useful green/red card when
      // the full pre-image is not in history.
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

/** Count tool rows that still carry structured file diffs. */
function countFileChangeTools(state: TranscriptState): number {
  let n = 0;
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (
      item?.kind === "tool" &&
      item.fileChanges &&
      item.fileChanges.length > 0
    ) {
      n += 1;
    }
  }
  return n;
}

/**
 * Copy reconstructed fileChanges (and clean argsDisplay) onto classic tools
 * that lost their payload after a message-only re-save.
 */
function enrichToolsFromMessages(
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

/**
 * Fallback when a history row only has model messages (no visual transcript),
 * or when the visual transcript is thinner than the model history (e.g. abort
 * stub saved after tools ran in-memory but never as transcript items).
 *
 * Reconstructs user / assistant bubbles and tool cards from native
 * `toolCalls` + `role: "tool"` pairs so /history still shows commands and
 * outputs when possible.
 */
export function hydrateFromMessages(messages: readonly ChatMessage[]): HydrateResult {
  const order: string[] = [];
  const byId = new Map<string, TranscriptItem>();
  const toolOutputs = new Map<ToolCallId, string>();
  let sequence = 0;

  // Index tool results by toolCallId for pairing with assistant toolCalls.
  const toolResultsById = new Map<string, ChatMessage>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      toolResultsById.set(message.toolCallId, message);
    }
  }

  for (const message of messages) {
    if (message.role === "system" || message.role === "tool") continue;

    if (message.role === "user") {
      // Recovery / governor nudges stay model-only — never a YOU bubble.
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

    // assistant
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
      // Successful plan/task bookkeeping belongs in the Tasks pane only.
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
      // See hydrateFromClassicTranscript — do not block the live sequencer.
      lastSequence: 0,
    },
    toolOutputs,
  };
}

/**
 * True when the visual transcript is missing the bulk of tool work that still
 * exists in model messages (common after abort-before-save of the UI snapshot).
 */
export function transcriptLooksIncomplete(
  transcriptLen: number,
  messages: readonly ChatMessage[],
): boolean {
  const toolMsgCount = messages.filter((m) => m.role === "tool").length;
  const toolCallCount = messages.reduce(
    (n, m) => n + (m.toolCalls?.length ?? 0),
    0,
  );
  const toolWork = Math.max(toolMsgCount, toolCallCount);
  if (toolWork === 0) return false;
  // Transcript has fewer tool rows than tool results in messages.
  // Callers may also treat a very short transcript vs many messages as incomplete.
  return transcriptLen < toolWork + 1;
}

/**
 * Prefer the richer of classic visual transcript vs message-derived hydrate
 * so /history does not drop tools when only one representation survived.
 *
 * Classic is enriched with `fileChanges` rebuilt from message tool args when
 * a prior message-only re-save wiped the structured diffs (common after
 * resume).
 */

export interface BoundedSessionVisualInput {
  readonly transcript: ClassicTranscriptItem[] | undefined;
  readonly messages: ChatMessage[];
  readonly omittedItems: number;
  readonly omittedMessages: number;
}

const VISUAL_TRANSCRIPT_ITEMS = 300;
const VISUAL_MESSAGE_ITEMS = 500;
const VISUAL_FIELD_CHARS = 32_000;
const VISUAL_TOTAL_CHARS = 2_000_000;

function capVisualField(value: string): string {
  if (value.length <= VISUAL_FIELD_CHARS) return value;
  return `${value.slice(0, VISUAL_FIELD_CHARS)}\n…[older output omitted from initial history view]`;
}

function boundedTranscriptItem(
  item: ClassicTranscriptItem,
): ClassicTranscriptItem {
  switch (item.kind) {
    case "user":
    case "assistant":
      return { ...item, text: capVisualField(item.text) };
    case "thinking":
      return { ...item, content: capVisualField(item.content) };
    case "notice":
      return { ...item, text: capVisualField(item.text) };
    case "tool":
      return {
        ...item,
        argsDisplay: capVisualField(item.argsDisplay),
        output: capVisualField(item.output),
        ...(item.summary
          ? { summary: capVisualField(item.summary) }
          : {}),
        ...(item.fileChanges && item.fileChanges.length <= 20
          ? { fileChanges: item.fileChanges }
          : { fileChanges: undefined }),
      };
    case "compacted":
      return {
        ...item,
        summary: capVisualField(item.summary),
        originalItems: [],
      };
    default:
      return item;
  }
}

export function boundSessionVisualInput(
  transcript: readonly ClassicTranscriptItem[] | undefined,
  messages: readonly ChatMessage[],
): BoundedSessionVisualInput {
  const recentMessages = messages.slice(-VISUAL_MESSAGE_ITEMS);
  const boundedMessages: ChatMessage[] = [];
  let messageChars = 0;
  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const message = recentMessages[index]!;
    const content = capVisualField(message.content);
    if (boundedMessages.length > 0 && messageChars + content.length > VISUAL_TOTAL_CHARS) {
      break;
    }
    messageChars += content.length;
    boundedMessages.push({
      ...message,
      content,
      ...(message.toolCalls
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              ...call,
              args: { restored: "Arguments available in the full session record" },
              rawArguments: undefined,
            })),
          }
        : {}),
    });
  }
  boundedMessages.reverse();

  const recentTranscript = transcript?.slice(-VISUAL_TRANSCRIPT_ITEMS);
  const boundedTranscript: ClassicTranscriptItem[] = [];
  let transcriptChars = 0;
  if (recentTranscript) {
    for (let index = recentTranscript.length - 1; index >= 0; index -= 1) {
      const item = boundedTranscriptItem(recentTranscript[index]!);
      const size =
        item.kind === "tool"
          ? item.output.length + item.argsDisplay.length
          : item.kind === "thinking"
            ? item.content.length
            : item.kind === "compacted"
              ? item.summary.length
              : item.kind === "plan"
                ? 4_000
                : item.text.length;
      if (
        boundedTranscript.length > 0 &&
        transcriptChars + size > VISUAL_TOTAL_CHARS
      ) {
        break;
      }
      transcriptChars += size;
      boundedTranscript.push(item);
    }
    boundedTranscript.reverse();
  }

  return {
    transcript: transcript ? boundedTranscript : undefined,
    messages: boundedMessages,
    omittedItems: Math.max(0, (transcript?.length ?? 0) - boundedTranscript.length),
    omittedMessages: Math.max(0, messages.length - boundedMessages.length),
  };
}

// Prefer the richer bounded representation. Classic wins ties to preserve
// thinking and structured file diffs.
export function hydrateSessionVisual(
  transcript: readonly ClassicTranscriptItem[] | undefined,
  messages: readonly ChatMessage[],
): HydrateResult {
  const fromMessages = hydrateFromMessages(messages);
  if (!transcript || transcript.length === 0) {
    return fromMessages;
  }
  const fromClassic = enrichToolsFromMessages(
    hydrateFromClassicTranscript(transcript),
    messages,
  );
  const classicToolCount = [...fromClassic.state.byId.values()].filter(
    (i) => i.kind === "tool",
  ).length;
  const messageToolCount = [...fromMessages.state.byId.values()].filter(
    (i) => i.kind === "tool",
  ).length;
  const classicFc = countFileChangeTools(fromClassic.state);
  const messageFc = countFileChangeTools(fromMessages.state);

  // Prefer the side that still has structured file diffs for write/edit cards.
  if (classicFc > messageFc) return fromClassic;
  if (messageFc > classicFc && messageToolCount >= classicToolCount) {
    return fromMessages;
  }
  // Prefer the snapshot with more tool cards (real work); break ties with
  // more total items, then classic (preserves thinking/notices + diffs).
  if (messageToolCount > classicToolCount + 2) return fromMessages;
  if (fromMessages.state.order.length > fromClassic.state.order.length * 1.5) {
    return fromMessages;
  }
  return fromClassic;
}

/**
 * Snapshot the live v2 transcript into the classic shape for history.db so
 * /history can restore tools + prompts next time (parity with classic clai).
 */
export function serializeForHistory(
  state: TranscriptState,
  toolOutput: (toolCallId: ToolCallId) => string,
): ClassicTranscriptItem[] {
  const out: ClassicTranscriptItem[] = [];
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (!item) continue;
    switch (item.kind) {
      case "user":
        out.push({ kind: "user", id: item.id, text: item.text, done: true });
        break;
      case "assistant":
        out.push({
          kind: "assistant",
          id: item.id,
          text: item.text,
          streaming: false,
          done: true,
        });
        break;
      case "thinking":
        out.push({
          kind: "thinking",
          id: item.id,
          content: item.content,
          done: true,
        });
        break;
      case "tool": {
        const output = toolOutput(item.toolCallId);
        out.push({
          kind: "tool",
          id: item.id,
          name: item.name,
          argsDisplay: item.argsDisplay,
          output,
          status:
            item.status === "failed"
              ? "fail"
              : item.status === "running" || item.status === "queued"
                ? "ok"
                : item.status,
          exitCode: item.exitCode,
          summary: item.summary,
          artifactPath: item.artifactPath,
          ...(item.fileChanges ? { fileChanges: item.fileChanges } : {}),
          done: true,
        });
        break;
      }
      case "notice":
        // Do not persist INFO/WARN banners to history.db — they are not
        // conversation, must not enter model context, and must not count
        // toward "N items" on resume.
        break;
      case "compacted":
        out.push({
          kind: "compacted",
          id: item.id,
          summary: item.summary,
          originalItems: [],
          done: true,
          beforeTokens: item.beforeTokens,
          afterTokens: item.afterTokens,
          ...(item.error ? { error: item.error } : {}),
        });
        break;
      default:
        break;
    }
  }
  return out;
}

/** Strip the model framing prefix for display in the compacted card. */
export function displayCompactSummary(summary: string): string {
  const prefixes = [
    "Session memory from compacted earlier turns:\n\n",
    "Session memory from compacted earlier turns:",
    "Session memory\n\n",
  ];
  let text = summary;
  for (const prefix of prefixes) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
      break;
    }
  }
  return text.trim();
}
