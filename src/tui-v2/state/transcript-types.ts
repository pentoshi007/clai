/**
 * Normalized transcript entities (V2-050).
 *
 * Items are keyed by a stable domain id — never an array index — so a
 * component can subscribe by id and the ScrollBox can give every row a
 * stable renderable id (ARCHITECTURE "Every dynamic row has a stable domain
 * id"). `order` is the append order; `byId` is the normalized lookup.
 */

import type { ToolCallId, TurnId } from "../../app/events/app-event.js";

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

export type ToolStatus = "running" | "ok" | "failed" | "blocked";

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
}

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ThinkingItem
  | ToolItem
  | NoticeItem
  | CompactedItem;

export interface TranscriptState {
  readonly order: readonly string[];
  readonly byId: ReadonlyMap<string, TranscriptItem>;
  /** Open streaming item id per kind, cleared once the final event lands. */
  readonly pendingAssistantId: string | undefined;
  readonly pendingThinkingId: string | undefined;
  readonly lastSequence: number;
  /** "step N" text from the most recent `status` event while a turn runs. */
  readonly runningStatus: string | undefined;
  readonly expandThinkingGlobal: boolean;
  readonly expandOutputGlobal: boolean;
  /** Per-item expand/collapse override; absent means "inherit the global". */
  readonly itemOverrides: ReadonlyMap<string, boolean>;
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
  itemOverrides: new Map(),
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

export function transcriptItems(state: TranscriptState): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (item) items.push(item);
  }
  return items;
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
    case "compacted":
      return item.summary;
    default: {
      const unreachable: never = item;
      throw new Error(`unhandled transcript item: ${JSON.stringify(unreachable)}`);
    }
  }
}
