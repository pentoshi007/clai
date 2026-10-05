import { shouldHideQuietMetaToolInChat } from "../../app/adapters/quiet-meta-tools.js";
import { isBatchToolName } from "../../ui-core/rendering/batch-sections.js";
import { presentTool } from "../../ui-core/rendering/tool-presenter.js";
import type { MarkdownStreamCache } from "../../ui-core/rendering/streaming-markdown.js";
import type {
  TranscriptItem,
  TranscriptState,
} from "../../ui-core/state/transcript-types.js";
import { isFileDiffExpanded, isItemExpanded } from "../../ui-core/state/transcript-types.js";
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
import { buildToolLines } from "../blocks/tool-lines.js";
import { buildTurnSummaryLines } from "../blocks/turn-summary-lines.js";
import { buildUserLines } from "../blocks/user-lines.js";
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

export const INTRO_ITEM_ID = "intro";
const toolKinds = new WeakMap<Extract<TranscriptItem, { kind: "tool" }>, BlockKind>();

export interface FeedViewInput {
  readonly columns: number;
  readonly ink: InkTheme;
  readonly now: number;
  readonly spool?: SpoolReader | undefined;
  readonly generation: number;
  readonly intro?: IntroBlockInput | undefined;
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
  const cached = toolKinds.get(item);
  if (cached) return cached;
  const kind = isBatchToolName(item.name) ? "batch" : presentTool(item).isFileDiff ? "diff" : "tool";
  toolKinds.set(item, kind);
  return kind;
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

interface RenderedLines {
  readonly lines: readonly string[];
  readonly markdownCache: MarkdownStreamCache | undefined;
}

function renderLines(
  ctx: BlockContext,
  item: TranscriptItem,
  kind: BlockKind,
  markdownCache: MarkdownStreamCache | undefined,
): RenderedLines {
  switch (kind) {
    case "user":
      return { lines: buildUserLines(ctx, item as Extract<TranscriptItem, { kind: "user" }>), markdownCache };
    case "assistant": {
      const result = buildAssistantLines(
        { ...ctx, markdownCache },
        item as Extract<TranscriptItem, { kind: "assistant" }>,
      );
      return { lines: result.lines, markdownCache: result.cache };
    }
    case "thinking":
      return { lines: buildThinkingLines(ctx, item as Extract<TranscriptItem, { kind: "thinking" }>), markdownCache };
    case "tool":
      return { lines: buildToolLines(ctx, item as Extract<TranscriptItem, { kind: "tool" }>), markdownCache };
    case "batch":
      return { lines: buildBatchLines(ctx, item as Extract<TranscriptItem, { kind: "tool" }>), markdownCache };
    case "diff":
      return { lines: buildDiffLines(ctx, item as Extract<TranscriptItem, { kind: "tool" }>), markdownCache };
    case "compacted":
      return { lines: buildCompactedLines(ctx, item as Extract<TranscriptItem, { kind: "compacted" }>), markdownCache };
    case "turn-summary":
      return { lines: buildTurnSummaryLines(ctx, item as Extract<TranscriptItem, { kind: "turn-summary" }>), markdownCache };
    default:
      return { lines: buildNoticeLines(ctx, item as Extract<TranscriptItem, { kind: "notice" }>), markdownCache };
  }
}

interface BlockInputs {
  readonly item: TranscriptItem;
  readonly kind: BlockKind;
  readonly width: number;
  readonly ink: InkTheme;
  readonly expanded: boolean;
  readonly diffExpanded: boolean;
  readonly output: string | number | undefined;
  readonly now: number | undefined;
}

interface CachedBlock {
  readonly inputs: BlockInputs;
  readonly lines: readonly string[];
  readonly markdownCache: MarkdownStreamCache | undefined;
  readonly block: FeedBlock | undefined;
}

function sameInputs(left: BlockInputs, right: BlockInputs): boolean {
  return (
    left.item === right.item &&
    left.kind === right.kind &&
    left.width === right.width &&
    left.ink === right.ink &&
    left.expanded === right.expanded &&
    left.diffExpanded === right.diffExpanded &&
    left.output === right.output &&
    left.now === right.now
  );
}

function blockInputs(ctx: BlockContext, item: TranscriptItem, kind: BlockKind): BlockInputs {
  const tool = item.kind === "tool" ? item : undefined;
  return {
    item,
    kind,
    width: ctx.width,
    ink: ctx.ink,
    expanded: isItemExpanded(ctx.state, item),
    diffExpanded: tool ? isFileDiffExpanded(ctx.state, item.id) : false,
    output: tool ? ctx.spool.version?.(tool.toolCallId) ?? ctx.spool.tail(tool.toolCallId) : undefined,
    now: isOpen(item) ? ctx.now : undefined,
  };
}

export class FeedBlockCache {
  private entries = new Map<string, CachedBlock>();
  private intro: { input: IntroBlockInput; width: number; ink: InkTheme; block: FeedBlock | undefined; generation: number } | undefined;

  introBlock(ctx: BlockContext, input: IntroBlockInput, generation: number): FeedBlock | undefined {
    const cached = this.intro;
    if (
      cached &&
      cached.input === input &&
      cached.width === ctx.width &&
      cached.ink === ctx.ink &&
      cached.generation === generation
    ) {
      return cached.block;
    }
    const lines = buildIntroLines(ctx, input);
    const block: FeedBlock | undefined = lines.length > 0
      ? {
          key: `${generation}:${INTRO_ITEM_ID}`,
          itemId: INTRO_ITEM_ID,
          kind: "intro",
          open: false,
          lines,
          turnId: undefined,
          sequence: -1,
        }
      : undefined;
    this.intro = { input, width: ctx.width, ink: ctx.ink, block, generation };
    return block;
  }

  itemBlock(
    ctx: BlockContext,
    item: TranscriptItem,
    kind: BlockKind,
    generation: number,
    next: Map<string, CachedBlock>,
  ): FeedBlock | undefined {
    const inputs = blockInputs(ctx, item, kind);
    const key = `${generation}:${item.id}`;
    const cached = this.entries.get(item.id);
    if (cached && sameInputs(cached.inputs, inputs)) {
      const reusable = !cached.block || cached.block.key === key;
      const entry = reusable ? cached : { ...cached, block: { ...cached.block!, key } };
      next.set(item.id, entry);
      return entry.block;
    }
    const markdownCache = cached?.inputs.ink === ctx.ink ? cached.markdownCache : undefined;
    const rendered = renderLines(ctx, item, kind, markdownCache);
    const lines = reflowRows(rendered.lines, ctx.width);
    const block: FeedBlock | undefined = lines.length > 0
      ? {
          key,
          itemId: item.id,
          kind,
          open: isOpen(item),
          lines,
          turnId: item.turnId,
          sequence: item.sequence,
        }
      : undefined;
    next.set(item.id, {
      inputs,
      lines,
      markdownCache: item.kind === "assistant" && item.streaming ? rendered.markdownCache : undefined,
      block,
    });
    return block;
  }

  commit(next: Map<string, CachedBlock>): void {
    this.entries = next;
  }
}

export function buildFeedBlocks(
  state: TranscriptState,
  view: FeedViewInput,
  cache: FeedBlockCache = new FeedBlockCache(),
): readonly FeedBlock[] {
  const ctx = blockContextFor(state, view);
  const blocks: FeedBlock[] = [];

  if (view.intro) {
    const intro = cache.introBlock(ctx, view.intro, view.generation);
    if (intro) blocks.push(intro);
  }

  const next = new Map<string, CachedBlock>();
  for (const id of state.order) {
    const item = state.byId.get(id);
    if (!item) continue;
    if (item.kind === "tool" && shouldHideQuietMetaToolInChat(item.name, item.status)) {
      continue;
    }
    const kind: BlockKind = item.kind === "tool" ? toolBlockKind(item) : item.kind;
    const block = cache.itemBlock(ctx, item, kind, view.generation, next);
    if (block) blocks.push(block);
  }
  cache.commit(next);

  return blocks;
}
