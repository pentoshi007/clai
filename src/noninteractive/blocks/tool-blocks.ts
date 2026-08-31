import type { AgentEvent } from "../../agent/events.js";
import { alignEnds, clipToWidth, joinSeparated, padStartToWidth, sealStyle, trimTrailingSpaces } from "../../classic/render/ansi-text.js";
import { adaptPresenterGlyphs } from "../../classic/render/glyphs.js";
import type { Glyphs } from "../../classic/render/glyphs.js";
import type { InkTheme, TextStyle, ThemeToken } from "../../classic/render/ink-theme.js";
import { wrapWithPrefixes } from "../../classic/render/wrap.js";
import type { SessionPlan } from "../../store/plan.js";
import { fileToolTitle } from "../../tools/file-diff.js";
import type { FileChange, FileChangeKind } from "../../tools/file-diff.js";
import { batchSummaryLine, buildBatchCardsFromSpool, parseBatchSections, presentBatchSection } from "../../ui-core/rendering/batch-sections.js";
import type { BatchSection } from "../../ui-core/rendering/batch-sections.js";
import { collapsedFileChangeLabel, presentFileChangePreview, syntaxColor } from "../../ui-core/rendering/file-diff-view.js";
import type { PresentedDiffRow } from "../../ui-core/rendering/file-diff-view.js";
import { cleanTaskTitle, progressView, TASK_STATE_LABEL, taskGlyph } from "../../ui-core/rendering/plan-view.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { cleanToolOutputLines } from "../../ui-core/rendering/tool-presenter.js";

export type StreamVerbosity = "quiet" | "normal" | "verbose";

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

/** Plan and batch sub-rows kept before a `… +N more` trailer. */
const SECTION_ROWS = 8;

export const BODY_INDENT = 4;

const GUTTER_WIDTH = 4;

const DIFF_CODE_COLUMN = GUTTER_WIDTH + 4;

export function quiet(ctx: StreamContext): boolean {
  return ctx.verbosity === "quiet";
}

export function verbose(ctx: StreamContext): boolean {
  return ctx.verbosity === "verbose";
}

export function row(ctx: StreamContext, text: string): string {
  return trimTrailingSpaces(clipToWidth(text, ctx.width, ctx.glyphs.ellipsis));
}

export function meta(ctx: StreamContext, parts: readonly (string | undefined)[]): string {
  return joinSeparated(parts, ` ${ctx.glyphs.separator} `);
}

export function styled(ctx: StreamContext, text: string, style: TextStyle): string {
  return ctx.ink.style(text, style);
}

/** `● name` on a glyph surface, `[tool] name` on an ASCII one. */
export function marker(ctx: StreamContext, glyph: string, label: string, token: ThemeToken): string {
  return ctx.plainPrefixes
    ? styled(ctx, `[${label}]`, { fg: token })
    : styled(ctx, glyph, { fg: token });
}

export function indented(
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

export function hiddenTrailer(ctx: StreamContext, hidden: number, extra?: string): string[] {
  if (hidden <= 0) return [];
  const body = meta(ctx, [
    `${ctx.glyphs.ellipsis} +${hidden} line${hidden === 1 ? "" : "s"}`,
    extra,
  ]);
  return [row(ctx, `${" ".repeat(BODY_INDENT)}${styled(ctx, body, { fg: "muted" })}`)];
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
