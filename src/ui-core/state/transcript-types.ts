/**
 * Normalized transcript entities (V2-050).
 *
 * Items are keyed by a stable domain id — never an array index — so a
 * component can subscribe by id and the ScrollBox can give every row a
 * stable renderable id (ARCHITECTURE "Every dynamic row has a stable domain
 * id"). `order` is the append order; `byId` is the normalized lookup.
 */

import type { ToolCallId, TurnId } from "../../app/events/app-event.js";
import type { FileChange } from "../../tools/file-diff.js";
import type { StripStream } from "../rendering/incremental-strip.js";

interface ItemBase {
  readonly id: string;
  readonly sequence: number;
  readonly turnId: TurnId | undefined;
  readonly timestamp: number;
}

export interface UserItem extends ItemBase {
  readonly kind: "user";
  readonly text: string;
}

export interface AssistantItem extends ItemBase {
  readonly kind: "assistant";
  readonly text: string;
  readonly streaming: boolean;
}

export interface ThinkingItem extends ItemBase {
  readonly kind: "thinking";
  readonly content: string;
  readonly streaming: boolean;
}

export type ToolStatus = "queued" | "running" | "ok" | "failed" | "blocked";

export interface ToolItem extends ItemBase {
  readonly kind: "tool";
  readonly toolCallId: ToolCallId;
  readonly name: string;
  readonly argsDisplay: string;
  readonly status: ToolStatus;
  readonly exitCode: number | undefined;
  readonly summary: string | undefined;
  readonly artifactPath: string | undefined;
  readonly reason: string | undefined;
  readonly outputBytes: number;
  /** Wall-clock of `tool-result` / `tool-blocked`; absent while open or hydrated. */
  readonly endedAt?: number | undefined;
  /** Structured file diffs for fs.edit / write / append / delete / … */
  readonly fileChanges: readonly FileChange[] | undefined;
}

export type NoticeLevel = "info" | "warn" | "error";

export interface NoticeItem extends ItemBase {
  readonly kind: "notice";
  readonly level: NoticeLevel;
  readonly text: string;
}

export interface CompactedItem extends ItemBase {
  readonly kind: "compacted";
  readonly summary: string;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly streaming?: boolean | undefined;
  readonly error?: string | undefined;
}

export function compactionTokenLabel(
  item: Pick<CompactedItem, "streaming" | "error" | "beforeTokens" | "afterTokens">,
): string {
  if (item.streaming) {
    return item.beforeTokens > 0
      ? `~${item.beforeTokens.toLocaleString()} tokens before`
      : "";
  }
  if (item.error) {
    const retainedTokens = item.afterTokens || item.beforeTokens;
    return retainedTokens > 0
      ? `~${retainedTokens.toLocaleString()} tokens · original context retained`
      : "original context retained";
  }
  return item.beforeTokens > 0 || item.afterTokens > 0
    ? `~${item.beforeTokens.toLocaleString()} → ~${item.afterTokens.toLocaleString()} tokens`
    : "";
}

export interface TurnSummaryItem extends ItemBase {
  readonly kind: "turn-summary";
  readonly durationMs: number;
  readonly status: "completed" | "aborted" | "error";
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | NoticeItem
  | CompactedItem
  | TurnSummaryItem;

export interface TranscriptState {
  readonly order: readonly string[];
  readonly byId: ReadonlyMap<string, TranscriptItem>;
  /** Open streaming item id per kind, cleared once the final event lands. */
  readonly pendingAssistantId: string | undefined;
  readonly pendingThinkingId: string | undefined;
  readonly lastSequence: number;
  /** "step N" text from the most recent `status` event while a turn runs. */
  readonly runningStatus: string | undefined;
  readonly activeTurnStartedAt?: number | undefined;
  readonly expandThinkingGlobal: boolean;
  readonly expandOutputGlobal: boolean;
  /**
   * File-diff cards (fs.edit / write / …): when true, show full DIFF hunks;
   * when false, collapse to verb + relative path only (unless overridden).
   */
  readonly expandFileDiffsGlobal: boolean;
  /** Per-item expand/collapse override; absent means "inherit the global". */
  readonly itemOverrides: ReadonlyMap<string, boolean>;
  /** Per-tool-card file-diff expand override (key = tool item id). */
  readonly fileDiffOverrides: ReadonlyMap<string, boolean>;
  /** Incremental strip state for the open assistant stream (bounded tail). */
  readonly assistantStripStreams: ReadonlyMap<string, StripStream>;
}

export const EMPTY_TRANSCRIPT_STATE: TranscriptState = {
  order: [],
  byId: new Map(),
  pendingAssistantId: undefined,
  pendingThinkingId: undefined,
  lastSequence: 0,
  runningStatus: undefined,
  expandThinkingGlobal: false,
  expandOutputGlobal: false,
  expandFileDiffsGlobal: true,
  itemOverrides: new Map(),
  fileDiffOverrides: new Map(),
  assistantStripStreams: new Map(),
};

/** CHAT-005/006/007: a per-item override always wins over the global toggle. */
export function isItemExpanded(state: TranscriptState, item: TranscriptItem): boolean {
  const override = state.itemOverrides.get(item.id);
  if (override !== undefined) return override;
  if (item.kind === "thinking") return state.expandThinkingGlobal;
  // Compacted memory cards share Ctrl+O with tool OUTPUT (classic parity).
  if (item.kind === "tool" || item.kind === "compacted") {
    return state.expandOutputGlobal;
  }
  return true;
}

/** Whether a tool card should show its file-diff hunks (vs collapsed title row). */
export function isFileDiffExpanded(state: TranscriptState, toolItemId: string): boolean {
  const override = state.fileDiffOverrides.get(toolItemId);
  if (override !== undefined) return override;
  return state.expandFileDiffsGlobal;
}

export function transcriptItems(state: TranscriptState): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (item) items.push(item);
  }
  return items;
}

/**
 * UI chrome only — INFO/WARN banners ("session resumed", "Ctrl+C again to exit").
 * Never model context, never history persistence, never conversation item counts.
 */
export function isUiOnlyTranscriptItem(item: TranscriptItem): boolean {
  return item.kind === "notice" || item.kind === "turn-summary";
}

/** Count conversation rows excluding ephemeral UI notices. */
export function conversationItemCount(state: TranscriptState): number {
  let n = 0;
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (item && !isUiOnlyTranscriptItem(item)) n += 1;
  }
  return n;
}

/** Plain text a search/export pass should scan for a given item. */
export function itemSearchText(item: TranscriptItem): string {
  switch (item.kind) {
    case "user":
      return item.text;
    case "assistant":
      return item.text;
    case "thinking":
      return item.content;
    case "tool":
      return [item.name, item.argsDisplay, item.summary, item.reason]
        .filter((part): part is string => Boolean(part))
        .join("\n");
    case "notice":
      return item.text;
    case "turn-summary":
      return "";
    case "compacted":
      return item.summary;
    default: {
      const unreachable: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(unreachable)}`);
    }
  }
}
