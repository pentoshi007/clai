import { shouldHideQuietMetaToolInChat } from "../../app/adapters/quiet-meta-tools.js";
import { isBatchToolName } from "../../ui-core/rendering/batch-sections.js";
import { presentTool } from "../../ui-core/rendering/tool-presenter.js";
import type { MarkdownStreamCache } from "../../ui-core/rendering/streaming-markdown.js";
import type {
  TranscriptItem,
  TranscriptState,
} from "../../ui-core/state/transcript-types.js";
import { isItemExpanded, transcriptItems } from "../../ui-core/state/transcript-types.js";
import type { InkTheme } from "../render/ink-theme.js";
import { contentWidth } from "../render/measure.js";
import { EMPTY_SPOOL, type BlockContext, type SpoolReader } from "../blocks/block-context.js";
import { buildAssistantLines } from "../blocks/assistant-lines.js";
import { buildBatchLines } from "../blocks/batch-lines.js";
import { buildCompactedLines } from "../blocks/compacted-lines.js";
import { buildDiffLines } from "../blocks/diff-lines.js";
import { buildIntroLines, type IntroBlockInput } from "../blocks/intro-lines.js";
import { buildNoticeLines } from "../blocks/notice-lines.js";
import { buildThinkingLines } from "../blocks/thinking-lines.js";
import { buildToolLines, outputToggleLabel } from "../blocks/tool-lines.js";
import { buildTurnSummaryLines } from "../blocks/turn-summary-lines.js";
import { buildUserLines } from "../blocks/user-lines.js";
import { clipRow, joinMeta } from "../blocks/block-context.js";
import { reflowRows } from "../render/wrap.js";

export type BlockKind =
  | "intro"
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "batch"
  | "diff"
  | "compacted"
  | "notice"
  | "turn-summary";

export interface FeedBlock {
  readonly key: string;
  readonly itemId: string;
  readonly kind: BlockKind;
  readonly open: boolean;
  readonly lines: readonly string[];
  readonly turnId: string | undefined;
  readonly sequence: number;
}

export const MAX_BLOCK_ROWS = 400;

export const INTRO_ITEM_ID = "intro";

export interface FeedViewInput {
  readonly columns: number;
  readonly ink: InkTheme;
  readonly now: number;
  readonly spool?: SpoolReader | undefined;
  readonly generation: number;
  readonly intro?: IntroBlockInput | undefined;
  readonly markdownCaches?: ReadonlyMap<string, MarkdownStreamCache> | undefined;
}

export function blockContextFor(state: TranscriptState, view: FeedViewInput): BlockContext {
  return {
    width: contentWidth(view.columns),
    ink: view.ink,
    glyphs: view.ink.glyphs,
    now: view.now,
    state,
    spool: view.spool ?? EMPTY_SPOOL,
    markdownCache: undefined,
  };
}

export function toolBlockKind(item: Extract<TranscriptItem, { kind: "tool" }>): BlockKind {
  if (isBatchToolName(item.name)) return "batch";
  return presentTool(item).isFileDiff ? "diff" : "tool";
}

function isOpen(item: TranscriptItem): boolean {
  switch (item.kind) {
    case "assistant":
    case "thinking":
      return item.streaming;
    case "tool":
      return item.status === "queued" || item.status === "running";
    case "compacted":
      return item.streaming === true;
    default:
      return false;
  }
}

function bound(
  ctx: BlockContext,
  item: TranscriptItem,
  lines: readonly string[],
): readonly string[] {
  if (lines.length <= MAX_BLOCK_ROWS) return lines;
  const kept = lines.slice(0, MAX_BLOCK_ROWS - 1);
  const hidden = lines.length - kept.length;
  const expandable = item.kind === "tool" || item.kind === "compacted";
  const footer = joinMeta(ctx, [
    expandable ? outputToggleLabel(isItemExpanded(ctx.state, item)) : undefined,
    `${ctx.glyphs.ellipsis} +${hidden} rows`,
  ]);
  return [...kept, clipRow(ctx, ctx.ink.fg("muted", footer))];
}

function linesFor(
  ctx: BlockContext,
  item: TranscriptItem,
  kind: BlockKind,
  view: FeedViewInput,
): readonly string[] {
  switch (kind) {
    case "user":
      return buildUserLines(ctx, item as Extract<TranscriptItem, { kind: "user" }>);
    case "assistant":
      return buildAssistantLines(
        { ...ctx, markdownCache: view.markdownCaches?.get(item.id) },
        item as Extract<TranscriptItem, { kind: "assistant" }>,
      ).lines;
    case "thinking":
      return buildThinkingLines(ctx, item as Extract<TranscriptItem, { kind: "thinking" }>);
    case "tool":
      return buildToolLines(ctx, item as Extract<TranscriptItem, { kind: "tool" }>);
    case "batch":
      return buildBatchLines(ctx, item as Extract<TranscriptItem, { kind: "tool" }>);
    case "diff":
      return buildDiffLines(ctx, item as Extract<TranscriptItem, { kind: "tool" }>);
    case "compacted":
      return buildCompactedLines(ctx, item as Extract<TranscriptItem, { kind: "compacted" }>);
    case "turn-summary":
      return buildTurnSummaryLines(ctx, item as Extract<TranscriptItem, { kind: "turn-summary" }>);
    default:
      return buildNoticeLines(ctx, item as Extract<TranscriptItem, { kind: "notice" }>);
  }
}

export function buildFeedBlocks(
  state: TranscriptState,
  view: FeedViewInput,
): readonly FeedBlock[] {
  const ctx = blockContextFor(state, view);
  const blocks: FeedBlock[] = [];

  if (view.intro) {
    const lines = buildIntroLines(ctx, view.intro);
    if (lines.length > 0) {
      blocks.push({
        key: `${view.generation}:${INTRO_ITEM_ID}`,
        itemId: INTRO_ITEM_ID,
        kind: "intro",
        open: false,
        lines,
        turnId: undefined,
        sequence: -1,
      });
    }
  }

  for (const item of transcriptItems(state)) {
    if (item.kind === "tool" && shouldHideQuietMetaToolInChat(item.name, item.status)) {
      continue;
    }
    const kind: BlockKind = item.kind === "tool" ? toolBlockKind(item) : item.kind;
    const lines = bound(ctx, item, reflowRows(linesFor(ctx, item, kind, view), ctx.width));
    if (lines.length === 0) continue;
    blocks.push({
      key: `${view.generation}:${item.id}`,
      itemId: item.id,
      kind,
      open: isOpen(item),
      lines,
      turnId: item.turnId,
      sequence: item.sequence,
    });
  }

  return blocks;
}
