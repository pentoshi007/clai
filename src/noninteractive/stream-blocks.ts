
import type { AgentEvent } from "../agent/events.js";
import { isFileMutationTool } from "../tools/file-diff.js";
import { adaptPresenterGlyphs, glyphsFor } from "../classic/render/glyphs.js";
import { createInkTheme, withColorMode, type ThemeToken } from "../classic/render/ink-theme.js";
import { contentWidth } from "../classic/render/measure.js";
import { wrapAnsiLine, wrapWithPrefixes } from "../classic/render/wrap.js";
import { clampArgsDisplay, presentOutput } from "../ui-core/rendering/tool-presenter.js";
import { renderMarkdownLines } from "../ui-core/rendering/render-markdown-lines.js";
import { sanitizeDisplayText } from "../ui-core/rendering/sanitize-display.js";
import { liveThinkingDisplay } from "../ui-core/rendering/thinking-tail.js";
import { BODY_INDENT, StreamContext, StreamVerbosity, hiddenTrailer, indented, marker, meta, quiet, row, styled, verbose } from "./blocks/tool-blocks.js";
export { buildBatchLines, buildPlanUpdateLines, buildToolDiffLines, buildToolResultLines } from "./blocks/tool-blocks.js";
export type { StreamContext, StreamVerbosity, ToolResultExtras } from "./blocks/tool-blocks.js";

export interface StreamContextInput {
  readonly columns: number;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly verbosity: StreamVerbosity;
  readonly showThinking: boolean;
}

export const COLLAPSED_BODY_ROWS = 3;
export const VERBOSE_BODY_ROWS = 40;

export function createStreamContext(input: StreamContextInput): StreamContext {
  return {
    width: Math.max(1, contentWidth(input.columns) - 2),
    ink: createInkTheme({
      themeHint: "dark",
      colorMode: input.color ? "truecolor" : "none",
      unicode: input.unicode,
      italic: false,
    }),
    glyphs: glyphsFor(input.unicode),
    verbosity: input.verbosity,
    showThinking: input.showThinking,
    plainPrefixes: !input.unicode,
    bodyRows: input.verbosity === "verbose" ? VERBOSE_BODY_ROWS : COLLAPSED_BODY_ROWS,
  };
}

export function buildTurnStartLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "turn-start" }>,
): readonly string[] {
  if (!verbose(ctx)) return [];
  const text = sanitizeDisplayText(event.displayPrompt ?? event.prompt).trim();
  if (text === "") return [];
  const rail = styled(ctx, `${ctx.glyphs.userRail} `, { fg: "userBorder" });
  return wrapWithPrefixes(text, { width: ctx.width - 2 }).map((line) =>
    row(ctx, `${rail}${styled(ctx, line, { fg: "muted" })}`),
  );
}

export function buildStatusLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "status" }>,
): readonly string[] {
  if (!verbose(ctx)) return [];
  const text = sanitizeDisplayText(event.text).trim();
  if (text === "") return [];
  return [row(ctx, styled(ctx, meta(ctx, [ctx.glyphs.separator, text]), { fg: "muted" }))];
}

export function buildThinkingDeltaLines(): readonly string[] {
  return [];
}

export function buildThinkingBlockLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "thinking-block" }>,
): readonly string[] {
  if (quiet(ctx) || !ctx.showThinking) return [];
  const content = sanitizeDisplayText(
    verbose(ctx) ? event.content : liveThinkingDisplay(event.content),
  ).trim();
  if (content === "") return [];
  const gutter = styled(ctx, `${ctx.glyphs.thinkingGutter} `, { fg: "thinking", dim: true });
  return wrapWithPrefixes(content, { width: ctx.width - 2 }).map((line) =>
    row(ctx, `${gutter}${styled(ctx, line, { fg: "thinking", dim: true })}`),
  );
}

export function buildAssistantDeltaLines(): readonly string[] {
  return [];
}

export function buildAssistantMessageLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "assistant-message" }>,
): readonly string[] {
  return renderAnswerLines(ctx, event.text);
}

export function renderAnswerLines(ctx: StreamContext, text: string): readonly string[] {
  const source = sanitizeDisplayText(text);
  if (source.trim() === "") return [];
  const bullet = styled(ctx, `${ctx.glyphs.assistantBullet} `, { fg: "magenta" });
  const rendered = withColorMode(ctx.ink.colorMode, () =>
    renderMarkdownLines(source, {
      width: Math.max(20, ctx.width - 2),
      stripOuterIndent: true,
    }),
  );
  const body = rendered.length > 0 ? rendered : [source];
  return body.map((line, index) => {
    if (line.trim() === "") return "";
    const paint = line.includes("\x1b") ? line : styled(ctx, line, { fg: "response" });
    return row(ctx, `${index === 0 ? bullet : "  "}${paint}`);
  });
}

export function buildNoticeLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "notice" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  const token: ThemeToken = event.level === "warn" ? "activity" : "muted";
  const head = marker(ctx, ctx.glyphs.warning, event.level, token);
  const text = sanitizeDisplayText(event.text).trim();
  if (text === "") return [];
  const rows = wrapWithPrefixes(text, { width: Math.max(1, ctx.width - 2) });
  return rows.map((line, index) =>
    row(ctx, `${index === 0 ? `${head} ` : "  "}${styled(ctx, line, { fg: token })}`),
  );
}

export function buildToolCallLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "tool-call" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  const glyph = marker(ctx, ctx.glyphs.toolRunning, "tool", "activity");
  const name = styled(ctx, event.name, { fg: "cyan", bold: true });
  const args = isFileMutationTool(event.name)
    ? undefined
    : clampArgsDisplay(event.argsDisplay || undefined)?.split("\n")[0]?.trim();
  const left = args
    ? `${glyph} ${name}${styled(ctx, `(${args})`, { fg: "muted" })}`
    : `${glyph} ${name}`;
  return [row(ctx, left)];
}

export function buildToolStartLines(): readonly string[] {
  return [];
}

export function buildToolOutputLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "tool-output" }>,
  tool: { readonly name?: string | undefined } = {},
): readonly string[] {
  if (quiet(ctx)) return [];
  const presented = presentOutput(event.chunk, undefined, verbose(ctx), tool.name);
  const kept = presented.lines.slice(0, ctx.bodyRows);
  if (kept.length === 0) return [];
  const hidden = presented.lines.length - kept.length + presented.hiddenAboveCount;

  const branch = styled(ctx, `  ${ctx.glyphs.bodyBranch} `, { fg: "muted" });
  const pad = " ".repeat(BODY_INDENT);
  const budget = Math.max(1, ctx.width - BODY_INDENT);
  const lines: string[] = [];
  for (const [index, raw] of kept.entries()) {
    const text = adaptPresenterGlyphs(raw, ctx.ink.unicode);
    for (const [wrapped, chunk] of wrapAnsiLine(text, budget).entries()) {
      const prefix = index === 0 && wrapped === 0 ? branch : pad;
      lines.push(row(ctx, `${prefix}${styled(ctx, chunk, { fg: "toolOutput" })}`));
    }
  }
  lines.push(...hiddenTrailer(ctx, hidden));
  if (presented.truncatedNotice) {
    lines.push(...indented(ctx, presented.truncatedNotice, { fg: "muted" }));
  }
  return lines;
}

export function buildToolBlockedLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "tool-blocked" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  const glyph = marker(ctx, ctx.glyphs.toolBlocked, "blocked", "activity");
  const name = styled(ctx, event.name, { fg: "cyan", bold: true });
  const lines = [
    row(ctx, `${glyph} ${name} ${styled(ctx, "blocked", { fg: "activity" })}`),
  ];
  const reason = sanitizeDisplayText(event.reason).trim();
  if (reason !== "") lines.push(...indented(ctx, reason, { fg: "activity" }));
  return lines;
}

export function buildConfirmRequestLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "confirm-request" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  const glyph = marker(ctx, ctx.glyphs.toolBlocked, "confirm", "activity");
  const text = sanitizeDisplayText(event.prompt).trim();
  return [row(ctx, `${glyph} ${styled(ctx, meta(ctx, [event.kind, text]), { fg: "activity" })}`)];
}

export function buildTurnEndLines(): readonly string[] {
  return [];
}

export function buildTurnAbortedLines(ctx: StreamContext): readonly string[] {
  if (quiet(ctx)) return [];
  const glyph = marker(ctx, ctx.glyphs.toolBlocked, "aborted", "activity");
  return [row(ctx, `${glyph} ${styled(ctx, "aborted", { fg: "activity" })}`)];
}

export function buildTurnErrorLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "turn-error" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  const glyph = marker(ctx, ctx.glyphs.toolFailed, "error", "diffDel");
  const text = sanitizeDisplayText(event.message).trim();
  return [row(ctx, `${glyph} ${styled(ctx, meta(ctx, ["error", text]), { fg: "diffDel" })}`)];
}

function tokenLabel(before: number, after: number): string | undefined {
  if (before <= 0 && after <= 0) return undefined;
  return `~${before.toLocaleString()} → ~${after.toLocaleString()} tokens`;
}

function compactionRow(
  ctx: StreamContext,
  head: string,
  label: string | undefined,
  token: ThemeToken,
): readonly string[] {
  const glyph = marker(ctx, ctx.glyphs.compacted, "compaction", token);
  return [row(ctx, `${glyph} ${styled(ctx, meta(ctx, [head, label]), { fg: token })}`)];
}

export function buildCompactionStartLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "compaction-start" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  const label =
    event.beforeTokens > 0 ? `~${event.beforeTokens.toLocaleString()} tokens before` : undefined;
  return compactionRow(ctx, "compacting context", label, "cyan");
}

export function buildCompactionDeltaLines(): readonly string[] {
  return [];
}

export function buildCompactionCompletedLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "compaction-completed" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  return compactionRow(
    ctx,
    "compacted context",
    tokenLabel(event.beforeTokens, event.afterTokens),
    "cyan",
  );
}

export function buildCompactionFailedLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "compaction-failed" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  const retained =
    event.retainedTokens > 0
      ? `~${event.retainedTokens.toLocaleString()} tokens retained`
      : "original context retained";
  return compactionRow(
    ctx,
    "compaction failed",
    meta(ctx, [sanitizeDisplayText(event.message).trim() || undefined, retained]),
    "activity",
  );
}

export function buildCompactedLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "compacted" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  return compactionRow(
    ctx,
    "compacted context",
    tokenLabel(event.beforeTokens, event.afterTokens),
    "cyan",
  );
}

export function buildTokenUsageLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "token-usage" }>,
): readonly string[] {
  if (!verbose(ctx)) return [];
  const usage = event.usage;
  const parts: (string | undefined)[] = [
    event.model,
    `${usage.promptTokens.toLocaleString()} in`,
    `${usage.completionTokens.toLocaleString()} out`,
  ];
  if (usage.cachedPromptTokens !== undefined) {
    parts.push(`${usage.cachedPromptTokens.toLocaleString()} cached`);
  }
  if (usage.cacheCreationTokens !== undefined) {
    parts.push(`${usage.cacheCreationTokens.toLocaleString()} cache-write`);
  }
  if (usage.reasoningTokens !== undefined) {
    parts.push(`${usage.reasoningTokens.toLocaleString()} reasoning`);
  }
  const body = meta(ctx, parts);
  return [row(ctx, styled(ctx, body, { fg: "muted" }))];
}

export function buildContextEstimateLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "context-estimate" }>,
): readonly string[] {
  if (!verbose(ctx)) return [];
  const body = meta(ctx, [
    event.model,
    `~${event.estimatedTokens.toLocaleString()} tokens assembled`,
  ]);
  return [row(ctx, styled(ctx, body, { fg: "muted" }))];
}
