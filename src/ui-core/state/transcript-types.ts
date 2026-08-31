
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
  readonly reasoningId?: string;
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
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
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
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
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
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
  readonly pendingAssistantId: string | undefined;
  readonly pendingThinkingId: string | undefined;
  readonly lastSequence: number;
  readonly runningStatus: string | undefined;
  readonly activeTurnStartedAt?: number | undefined;
  readonly expandThinkingGlobal: boolean;
  readonly expandOutputGlobal: boolean;
  readonly expandFileDiffsGlobal: boolean;
  readonly itemOverrides: ReadonlyMap<string, boolean>;
  readonly fileDiffOverrides: ReadonlyMap<string, boolean>;
  readonly focusedThinkingId: string | undefined;
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
  focusedThinkingId: undefined,
  assistantStripStreams: new Map(),
};

export function isItemExpanded(state: TranscriptState, item: TranscriptItem): boolean {
  const override = state.itemOverrides.get(item.id);
  if (override !== undefined) return override;
  if (item.kind === "thinking") return state.expandThinkingGlobal;
  if (item.kind === "tool" || item.kind === "compacted") {
    return state.expandOutputGlobal;
  }
  return true;
}

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

export function isUiOnlyTranscriptItem(item: TranscriptItem): boolean {
  return item.kind === "notice" || item.kind === "turn-summary";
}

export function conversationItemCount(state: TranscriptState): number {
  let n = 0;
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (item && !isUiOnlyTranscriptItem(item)) n += 1;
  }
  return n;
}

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
