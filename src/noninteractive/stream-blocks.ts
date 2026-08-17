/**
 * Pure line builders for the non-interactive surface (06-ONESHOT §2/§3).
 *
 * One exported function per `AgentEvent` kind, each returning `readonly
 * string[]`. No streams, no clocks, no process reads — every row is derived
 * from the event plus the injected `StreamContext`, and every glyph, colour and
 * body preview comes from the same `ui-core` presenters the Ink feed uses.
 */

import type { AgentEvent } from "../agent/events.js";
import type { SessionPlan } from "../store/plan.js";
import type { FileChange } from "../tools/file-diff.js";
import { fileToolTitle, isFileMutationTool, type FileChangeKind } from "../tools/file-diff.js";
import {
  alignEnds,
  clipToWidth,
  joinSeparated,
  padStartToWidth,
  sealStyle,
  trimTrailingSpaces,
} from "../classic/render/ansi-text.js";
import { adaptPresenterGlyphs, glyphsFor, type Glyphs } from "../classic/render/glyphs.js";
import {
  createInkTheme,
  withColorMode,
  type InkTheme,
  type TextStyle,
  type ThemeToken,
} from "../classic/render/ink-theme.js";
import { contentWidth } from "../classic/render/measure.js";
import { wrapAnsiLine, wrapWithPrefixes } from "../classic/render/wrap.js";
import {
  batchSummaryLine,
  buildBatchCardsFromSpool,
  parseBatchSections,
  presentBatchSection,
  type BatchSection,
} from "../ui-core/rendering/batch-sections.js";
import {
  collapsedFileChangeLabel,
  presentFileChangePreview,
  syntaxColor,
  type PresentedDiffRow,
} from "../ui-core/rendering/file-diff-view.js";
import {
  cleanToolOutputLines,
  clampArgsDisplay,
  presentOutput,
} from "../ui-core/rendering/tool-presenter.js";
import { renderMarkdownLines } from "../ui-core/rendering/render-markdown-lines.js";
import { sanitizeDisplayText } from "../ui-core/rendering/sanitize-display.js";
import { liveThinkingDisplay } from "../ui-core/rendering/thinking-tail.js";
import {
  cleanTaskTitle,
  progressView,
  taskGlyph,
  TASK_STATE_LABEL,
} from "../ui-core/rendering/plan-view.js";

export type StreamVerbosity = "quiet" | "normal" | "verbose";

export interface StreamContextInput {
  readonly columns: number;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly verbosity: StreamVerbosity;
  readonly showThinking: boolean;
}

export interface StreamContext {
  /** Content columns available to a row: `columns - 2`. */
  readonly width: number;
  readonly ink: InkTheme;
  readonly glyphs: Glyphs;
  readonly verbosity: StreamVerbosity;
  readonly showThinking: boolean;
  /** ASCII surfaces spell status out as `[tool]` rather than paint a glyph. */
  readonly plainPrefixes: boolean;
  /** Collapsed body rows; `--verbose` raises the cap (§3 rule 5). */
  readonly bodyRows: number;
}

/** Collapsed tool-output preview rows, and the `--verbose` ceiling. */
export const COLLAPSED_BODY_ROWS = 3;
export const VERBOSE_BODY_ROWS = 40;
/** Plan and batch sub-rows kept before a `… +N more` trailer. */
const SECTION_ROWS = 8;
const BODY_INDENT = 4;
const GUTTER_WIDTH = 4;
const DIFF_CODE_COLUMN = GUTTER_WIDTH + 4;

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

function quiet(ctx: StreamContext): boolean {
  return ctx.verbosity === "quiet";
}

function verbose(ctx: StreamContext): boolean {
  return ctx.verbosity === "verbose";
}

function row(ctx: StreamContext, text: string): string {
  return trimTrailingSpaces(clipToWidth(text, ctx.width, ctx.glyphs.ellipsis));
}

function meta(ctx: StreamContext, parts: readonly (string | undefined)[]): string {
  return joinSeparated(parts, ` ${ctx.glyphs.separator} `);
}

function styled(ctx: StreamContext, text: string, style: TextStyle): string {
  return ctx.ink.style(text, style);
}

/** `● name` on a glyph surface, `[tool] name` on an ASCII one. */
function marker(ctx: StreamContext, glyph: string, label: string, token: ThemeToken): string {
  return ctx.plainPrefixes
    ? styled(ctx, `[${label}]`, { fg: token })
    : styled(ctx, glyph, { fg: token });
}

function indented(
  ctx: StreamContext,
  text: string,
  style: TextStyle,
  indent = BODY_INDENT,
): string[] {
  const pad = " ".repeat(indent);
  return wrapWithPrefixes(text, { width: Math.max(1, ctx.width - indent) }).map((line) =>
    row(ctx, `${pad}${styled(ctx, line, style)}`),
  );
}

function hiddenTrailer(ctx: StreamContext, hidden: number, extra?: string): string[] {
  if (hidden <= 0) return [];
  const body = meta(ctx, [
    `${ctx.glyphs.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`,
    extra,
  ]);
  return [row(ctx, `${" ".repeat(BODY_INDENT)}${styled(ctx, body, { fg: "muted" })}`)];
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

/** Status text drives the spinner at `normal`; `--verbose` also logs each one. */
export function buildStatusLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "status" }>,
): readonly string[] {
  if (!verbose(ctx)) return [];
  const text = sanitizeDisplayText(event.text).trim();
  if (text === "") return [];
  return [row(ctx, styled(ctx, meta(ctx, [ctx.glyphs.separator, text]), { fg: "muted" }))];
}

/** Streaming fragments are aggregated by their terminal event; nothing to print. */
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

/** Shared by `assistant-message` and the `finish()` outcome write. */
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

/** Queued → executing is a spinner label change, not a transcript row. */
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

const RESULT_LABEL: Record<"ok" | "failed", string> = { ok: "done", failed: "failed" };

function exitSuffix(ctx: StreamContext, exitCode: number | undefined): string | undefined {
  if (exitCode === undefined || exitCode === 0) return undefined;
  if (exitCode === 127) return meta(ctx, [String(exitCode), "not found"]);
  if (exitCode === 126) return meta(ctx, [String(exitCode), "not executable"]);
  return String(exitCode);
}

export interface ToolResultExtras {
  /** Wall time for the call, injected by the renderer's clock. */
  readonly elapsed?: string | undefined;
}

export function buildToolResultLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "tool-result" }>,
  extras: ToolResultExtras = {},
): readonly string[] {
  if (quiet(ctx)) return [];
  const state = event.ok ? "ok" : "failed";
  const token: ThemeToken = event.ok ? "success" : "diffDel";
  const glyph = marker(
    ctx,
    event.ok ? ctx.glyphs.toolOk : ctx.glyphs.toolFailed,
    state,
    token,
  );
  const body = meta(ctx, [
    RESULT_LABEL[state],
    exitSuffix(ctx, event.exitCode),
    extras.elapsed,
  ]);
  const lines = [row(ctx, `${glyph} ${styled(ctx, body, { fg: token })}`)];
  if (!event.ok) {
    const detail = sanitizeDisplayText(event.summary).split("\n")[0]?.trim();
    if (detail) lines.push(...indented(ctx, detail, { fg: "diffDel" }));
  }
  if (event.artifactPath) {
    lines.push(...indented(ctx, `saved ${event.artifactPath}`, { fg: "muted" }));
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

function statsSuffix(ctx: StreamContext, change: FileChange): string {
  const minus = ctx.ink.unicode ? "−" : "-";
  return `${styled(ctx, `+${change.stats.added}`, { fg: "diffAdd" })} ${styled(
    ctx,
    `${minus}${change.stats.removed}`,
    { fg: "diffDel" },
  )}`;
}

function diffRowLine(ctx: StreamContext, line: PresentedDiffRow): string {
  const prefix = line.prefix === "−" && !ctx.ink.unicode ? "-" : line.prefix;
  const tone: TextStyle =
    line.tone === "add"
      ? { fg: "diffAdd" }
      : line.tone === "del"
        ? { fg: "diffDel" }
        : line.tone === "gap"
          ? { fg: "muted" }
          : line.tone === "header"
            ? { fg: "muted", bold: true }
            : {};
  const gutter = styled(ctx, padStartToWidth(line.gutter, GUTTER_WIDTH), {
    fg: "diffGutter",
  });
  const head = `${gutter} ${styled(ctx, prefix, tone)}  `;
  const budget = Math.max(1, ctx.width - DIFF_CODE_COLUMN);
  let text = line.displayText.slice(0, budget);
  if (line.tone === "context" && ctx.ink.colorMode !== "none") {
    text = "";
    for (const span of line.spans) {
      text += ctx.ink.hex(syntaxColor(span.kind, ctx.ink.theme), span.text);
    }
    text = clipToWidth(text, budget);
  } else if (line.tone !== "context") {
    text = styled(ctx, text, tone);
  }
  return row(ctx, sealStyle(`${head}${text}`));
}

/**
 * File-diff card for a mutation tool: title row plus `+N −M`, hunks only under
 * `--verbose` (§3 rule 6).
 */
export function buildToolDiffLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "tool-result" }>,
  name: string,
): readonly string[] {
  if (quiet(ctx)) return [];
  const changes = event.fileChanges ?? [];
  const primary = changes[0];
  const status = event.ok ? "ok" : "failed";
  const pathOrDisplay =
    changes.length > 1 ? `${changes.length} file(s)` : (primary?.path ?? "");
  const titled = fileToolTitle(
    name,
    status,
    pathOrDisplay,
    primary?.kind as FileChangeKind | undefined,
  );
  const glyph = marker(
    ctx,
    event.ok ? ctx.glyphs.toolOk : ctx.glyphs.toolFailed,
    status,
    event.ok ? "success" : "diffDel",
  );
  const left = `${glyph} ${styled(ctx, titled.title, { fg: "cyan", bold: true })}`;
  const lines = [
    alignEnds(
      left,
      primary ? statsSuffix(ctx, primary) : "",
      ctx.width,
      ctx.glyphs.ellipsis,
    ),
  ];
  if (!primary) return lines;
  if (!verbose(ctx)) {
    lines.push(
      row(ctx, `  ${styled(ctx, collapsedFileChangeLabel(primary), { fg: "muted" })}`),
    );
    return lines;
  }

  const maxRows = ctx.bodyRows;
  const maxLineChars = Math.max(16, ctx.width - DIFF_CODE_COLUMN);
  let emitted = 0;
  for (const change of changes) {
    if (emitted >= maxRows) break;
    if (changes.length > 1) {
      lines.push(
        row(
          ctx,
          `  ${styled(ctx, change.path, { fg: "cyan" })} ${statsSuffix(ctx, change)}`,
        ),
      );
    }
    for (const line of presentFileChangePreview(change, { maxLineChars, maxRows })) {
      if (emitted >= maxRows) break;
      lines.push(diffRowLine(ctx, line));
      emitted += 1;
    }
  }
  const total = changes.reduce((sum, c) => sum + c.stats.added + c.stats.removed, 0);
  lines.push(...hiddenTrailer(ctx, Math.max(0, total - emitted)));
  return lines;
}

function batchSectionsFor(body: string): BatchSection[] {
  const parsed = parseBatchSections(body);
  return parsed.length > 0 ? parsed : buildBatchCardsFromSpool(body);
}

/** `tool.batch` body: one row per nested tool, plus the shared summary line. */
export function buildBatchLines(ctx: StreamContext, body: string): readonly string[] {
  if (quiet(ctx)) return [];
  const sections = batchSectionsFor(body);
  if (sections.length === 0) return [];
  const cap = verbose(ctx) ? sections.length : SECTION_ROWS;
  const shown = sections.slice(0, cap);
  const lines: string[] = [];
  for (const section of shown) {
    const status = section.status ?? (section.ok ? "ok" : "fail");
    const presented = presentBatchSection(section, verbose(ctx));
    const token: ThemeToken =
      status === "ok" ? "success" : status === "running" ? "activity" : "diffDel";
    const glyph = marker(ctx, adaptPresenterGlyphs(presented.glyph, ctx.ink.unicode), status, token);
    lines.push(
      alignEnds(
        `  ${glyph} ${styled(ctx, section.name, { fg: "cyan" })}`,
        styled(ctx, presented.statusLabel, { fg: token }),
        ctx.width,
        ctx.glyphs.ellipsis,
      ),
    );
    if (!verbose(ctx) || !presented.hasBody) continue;
    for (const line of cleanToolOutputLines(section.body).slice(0, ctx.bodyRows)) {
      lines.push(
        row(
          ctx,
          `${" ".repeat(BODY_INDENT)}${styled(ctx, adaptPresenterGlyphs(line, ctx.ink.unicode), { fg: "toolOutput" })}`,
        ),
      );
    }
  }
  const hidden = sections.length - shown.length;
  const footer = meta(ctx, [
    batchSummaryLine(sections) || undefined,
    hidden > 0 ? `${ctx.glyphs.ellipsis} +${hidden} more` : undefined,
  ]);
  if (footer !== "") lines.push(row(ctx, `  ${styled(ctx, footer, { fg: "muted" })}`));
  return lines;
}

export function buildPlanUpdateLines(
  ctx: StreamContext,
  event: Extract<AgentEvent, { type: "plan-update" }>,
): readonly string[] {
  if (quiet(ctx)) return [];
  const plan: SessionPlan = event.plan;
  const progress = progressView(plan);
  const glyph = marker(ctx, ctx.glyphs.compacted, "plan", "magenta");
  const head = meta(ctx, ["plan", `${progress.done}/${progress.total}`, plan.status]);
  const lines = [row(ctx, `${glyph} ${styled(ctx, head, { fg: "magenta" })}`)];
  const cap = verbose(ctx) ? plan.tasks.length : SECTION_ROWS;
  for (const task of plan.tasks.slice(0, cap)) {
    const mark = ctx.plainPrefixes
      ? `[${TASK_STATE_LABEL[task.state]}]`
      : adaptPresenterGlyphs(taskGlyph(task), ctx.ink.unicode);
    lines.push(
      row(ctx, `  ${styled(ctx, `${mark} ${cleanTaskTitle(task)}`, { fg: "muted" })}`),
    );
  }
  const hidden = plan.tasks.length - Math.min(plan.tasks.length, cap);
  if (hidden > 0) {
    lines.push(
      row(
        ctx,
        `  ${styled(ctx, `${ctx.glyphs.ellipsis} +${hidden} more`, { fg: "muted" })}`,
      ),
    );
  }
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

/** The outcome is written by `finish()`; `turn-end` itself prints nothing. */
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

/** Compaction bodies never stream to the transcript (§3 rule 8). */
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
