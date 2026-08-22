import chalk from "chalk";
import {
  usageCacheHitRate,
  type SessionUsageReport,
  type SessionUsageRoute,
  type SessionUsageTotals,
} from "../../app/controllers/session-usage-ledger.js";
import { formatDurationMs } from "./duration.js";
import { renderColumns } from "./text-width.js";
import {
  renderWordmark,
  wordmarkWidth,
  type WordmarkSize,
} from "./wordmark.js";

const BRAND_HEX = "#2EEBFF";
const MISSING = "—";
const MISSING_ASCII = "-";
const INDENT = "  ";
const LOGO_GAP = 4;
const LOGO_GAP_TIGHT = 2;
const MIN_WIDTH = 16;
const MIN_INFO = 24;
const MIN_LABEL_COLUMNS = 10;
const COLUMN_GAP = 2;
const LABEL_HEADERS = ["PROVIDER / MODEL", "PROVIDER/MODEL", "MODEL"] as const;

const METRIC_COLUMNS = ["REQ", "IN", "OUT", "TOTAL", "CACHE"] as const;
type MetricColumn = (typeof METRIC_COLUMNS)[number];

const DROP_ORDER: readonly MetricColumn[] = ["CACHE", "OUT", "IN", "REQ", "TOTAL"];

export interface ExitSummaryInput {
  readonly usage: SessionUsageReport;
  readonly sessionId: string;
  readonly title?: string | undefined;
  readonly messages: number;
  readonly cwd: string;
  readonly durationMs: number;
  readonly resumable: boolean;
  readonly width: number;
  readonly color: boolean;
  readonly unicode: boolean;
}

export function resumeCommand(sessionId: string): string {
  return `clai --resume ${sessionId}`;
}

type Paint = (text: string) => string;

interface Palette {
  readonly brand: Paint;
  readonly title: Paint;
  readonly muted: Paint;
  readonly label: Paint;
  readonly value: Paint;
  readonly total: Paint;
  readonly command: Paint;
}

const IDENTITY: Paint = (text) => text;

function palette(color: boolean): Palette {
  if (!color) {
    return {
      brand: IDENTITY,
      title: IDENTITY,
      muted: IDENTITY,
      label: IDENTITY,
      value: IDENTITY,
      total: IDENTITY,
      command: IDENTITY,
    };
  }
  return {
    brand: (text) => chalk.bold.hex(BRAND_HEX)(text),
    title: (text) => chalk.bold.whiteBright(text),
    muted: (text) => chalk.dim(text),
    label: (text) => chalk.gray(text),
    value: (text) => chalk.whiteBright(text),
    total: (text) => chalk.bold.cyanBright(text),
    command: (text) => chalk.bold.hex(BRAND_HEX)(text),
  };
}

interface Glyphs {
  readonly horizontal: string;
  readonly bullet: string;
  readonly missing: string;
}

const UNICODE_GLYPHS: Glyphs = {
  horizontal: "─",
  bullet: "·",
  missing: MISSING,
};

const ASCII_GLYPHS: Glyphs = {
  horizontal: "-",
  bullet: "-",
  missing: MISSING_ASCII,
};

function count(value: number): string {
  return value.toLocaleString("en-US");
}

function percent(value: number | undefined, glyphs: Glyphs): string {
  if (value === undefined) return glyphs.missing;
  const scaled = value * 100;
  if (scaled > 0 && scaled < 0.1) return "<0.1%";
  return `${scaled.toFixed(1)}%`;
}

function plural(value: number, singular: string): string {
  return `${count(value)} ${singular}${value === 1 ? "" : "s"}`;
}

function truncateEnd(text: string, width: number): string {
  if (width <= 0) return "";
  if (renderColumns(text) <= width) return text;
  if (width === 1) return [...text][0] ?? "";
  let out = "";
  for (const char of text) {
    if (renderColumns(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}

function truncateMiddle(text: string, width: number): string {
  if (width <= 0) return "";
  if (renderColumns(text) <= width) return text;
  if (width <= 3) return truncateEnd(text, width);
  const chars = [...text];
  const keep = width - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}

function padStart(text: string, width: number): string {
  const gap = width - renderColumns(text);
  return gap > 0 ? " ".repeat(gap) + text : text;
}

function padEnd(text: string, width: number): string {
  const gap = width - renderColumns(text);
  return gap > 0 ? text + " ".repeat(gap) : text;
}

interface Segment {
  readonly plain: string;
  readonly paint: Paint;
}

function paintSegments(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.paint(segment.plain)).join("");
}

interface TableRow {
  readonly provider: string;
  readonly model: string;
  readonly cells: Record<MetricColumn, string>;
  readonly emphasis: boolean;
}

interface ColumnFit {
  readonly columns: readonly MetricColumn[];
  readonly widths: ReadonlyMap<MetricColumn, number>;
  readonly label: number;
  readonly compact: boolean;
}

function metricCells(
  entry: SessionUsageRoute | SessionUsageTotals,
  glyphs: Glyphs,
): Record<MetricColumn, string> {
  return {
    REQ: count(entry.requests),
    IN: count(entry.promptTokens),
    OUT: count(entry.completionTokens),
    TOTAL: count(entry.totalTokens),
    CACHE: percent(usageCacheHitRate(entry), glyphs),
  };
}

function labelPlain(row: TableRow): string {
  return row.model ? `${row.provider} / ${row.model}` : row.provider;
}

function measureColumns(
  rows: readonly TableRow[],
  columns: readonly MetricColumn[],
): Map<MetricColumn, number> {
  const widths = new Map<MetricColumn, number>();
  for (const column of columns) {
    let width = renderColumns(column);
    for (const row of rows) {
      width = Math.max(width, renderColumns(row.cells[column]));
    }
    widths.set(column, width);
  }
  return widths;
}

function metricsWidth(
  columns: readonly MetricColumn[],
  widths: ReadonlyMap<MetricColumn, number>,
): number {
  return columns.reduce(
    (total, column) => total + (widths.get(column) ?? 0) + COLUMN_GAP,
    0,
  );
}

function labelHeader(width: number, compact: boolean): string {
  const header = compact
    ? "MODEL"
    : (LABEL_HEADERS.find((candidate) => renderColumns(candidate) <= width) ??
      "MODEL");
  return truncateEnd(header, width);
}

/**
 * Sizes the label column to its content instead of stretching it across the
 * terminal, and only drops the provider prefix once the full `provider / model`
 * form no longer fits.
 */
function fitColumns(
  rows: readonly TableRow[],
  desired: { readonly full: number; readonly model: number },
  available: number,
): ColumnFit {
  let columns: readonly MetricColumn[] = METRIC_COLUMNS;
  for (let dropped = 0; ; dropped += 1) {
    const widths = measureColumns(rows, columns);
    const room = available - metricsWidth(columns, widths);
    const enough = room >= Math.min(desired.model, MIN_LABEL_COLUMNS);
    if (enough || dropped >= DROP_ORDER.length || columns.length <= 1) {
      if (room >= desired.full) {
        return { columns, widths, label: desired.full, compact: false };
      }
      return {
        columns,
        widths,
        label: Math.max(1, Math.min(desired.model, room)),
        compact: true,
      };
    }
    const next = DROP_ORDER[dropped];
    columns = columns.filter((column) => column !== next);
  }
}

function labelSegments(
  row: TableRow,
  fit: ColumnFit,
  colors: Palette,
  compact: boolean,
): Segment[] {
  const emphasis = row.emphasis ? colors.total : colors.value;
  const solo = (text: string): Segment[] => [
    { plain: padEnd(truncateMiddle(text, fit.label), fit.label), paint: emphasis },
  ];
  if (!row.model) return solo(row.provider);
  if (compact) return solo(row.model);

  const separator = " / ";
  const providerRoom = Math.max(
    3,
    Math.min(renderColumns(row.provider), Math.floor(fit.label / 2)),
  );
  const provider = truncateEnd(row.provider, providerRoom);
  const modelRoom =
    fit.label - renderColumns(provider) - renderColumns(separator);
  if (modelRoom < 4) return solo(row.model);
  const model = truncateMiddle(row.model, modelRoom);
  const used =
    renderColumns(provider) + renderColumns(separator) + renderColumns(model);
  return [
    { plain: provider, paint: row.emphasis ? colors.total : colors.label },
    { plain: separator, paint: colors.muted },
    { plain: model, paint: emphasis },
    { plain: " ".repeat(Math.max(0, fit.label - used)), paint: IDENTITY },
  ];
}

function metricSegments(
  cells: (column: MetricColumn) => string,
  fit: ColumnFit,
  paint: Paint,
  glyphs: Glyphs,
  colors: Palette,
): Segment[] {
  return fit.columns.flatMap((column) => {
    const value = cells(column);
    const cell = padStart(value, fit.widths.get(column) ?? 0);
    return [
      { plain: " ".repeat(COLUMN_GAP), paint: IDENTITY },
      { plain: cell, paint: value === glyphs.missing ? colors.muted : paint },
    ];
  });
}

/**
 * The usage table, rendered without vertical borders: a dim header, a rule, the
 * routes, a rule, then the emphasized totals. Rules span the columns only, so
 * the table never stretches to the terminal edge.
 */
function tableLines(
  report: SessionUsageReport,
  available: number,
  colors: Palette,
  glyphs: Glyphs,
): string[] {
  const routes: TableRow[] = report.routes.map((route) => ({
    provider: route.provider ?? "unknown",
    model: route.model ?? "unknown",
    cells: metricCells(route, glyphs),
    emphasis: false,
  }));
  const totalsLabel = `TOTAL ${glyphs.bullet} ${plural(report.totals.routes, "route")}`;
  const totals: TableRow = {
    provider: totalsLabel,
    model: "",
    cells: metricCells(report.totals, glyphs),
    emphasis: true,
  };

  const widest = (values: readonly string[]): number =>
    values.reduce((max, value) => Math.max(max, renderColumns(value)), 0);
  const desired = {
    full: widest([...routes.map(labelPlain), totalsLabel, LABEL_HEADERS[0]]),
    model: widest([...routes.map((row) => row.model), "TOTAL", "MODEL"]),
  };

  const fit = fitColumns([...routes, totals], desired, available);
  const compact = fit.compact;
  const labelled: TableRow = {
    ...totals,
    provider: compact ? "TOTAL" : totalsLabel,
  };

  const header = paintSegments([
    {
      plain: padEnd(labelHeader(fit.label, compact), fit.label),
      paint: colors.muted,
    },
    ...metricSegments((column) => column, fit, colors.muted, glyphs, colors),
  ]);
  const body = routes.map((row) =>
    paintSegments([
      ...labelSegments(row, fit, colors, compact),
      ...metricSegments(
        (column) => row.cells[column],
        fit,
        colors.value,
        glyphs,
        colors,
      ),
    ]),
  );
  const totalRow = paintSegments([
    ...labelSegments(labelled, fit, colors, compact),
    ...metricSegments(
      (column) => labelled.cells[column],
      fit,
      colors.total,
      glyphs,
      colors,
    ),
  ]);

  const span = Math.min(
    available,
    fit.label + metricsWidth(fit.columns, fit.widths),
  );
  const rule = colors.muted(glyphs.horizontal.repeat(Math.max(1, span)));
  return [header, rule, ...body, rule, totalRow];
}

function footnotes(totals: SessionUsageTotals, glyphs: Glyphs): string[] {
  const notes: string[] = [];
  if (totals.reasoningTokens !== undefined && totals.reasoningTokens > 0) {
    notes.push(`reasoning ${count(totals.reasoningTokens)}`);
  } else if (totals.reasoningObserved) {
    notes.push("reasoning observed");
  }
  if (totals.cacheCreationTokens !== undefined && totals.cacheCreationTokens > 0) {
    notes.push(`cache write ${count(totals.cacheCreationTokens)}`);
  }
  if (totals.estimatedRequests > 0) {
    notes.push(plural(totals.estimatedRequests, "estimated request"));
  }
  if (totals.unmeasuredPromptRequests > 0) {
    notes.push(
      `${plural(totals.unmeasuredPromptRequests, "request")} without an input count`,
    );
  }
  if (totals.cachedPromptTokens === undefined) {
    notes.push(`cache ${glyphs.missing} not reported`);
  }
  return notes;
}

function shortenPath(path: string, width: number): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const shown = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return truncateMiddle(shown, width);
}

interface InfoLine {
  readonly plain: string;
  readonly painted: string;
}

const NOT_SAVED_TAIL = "cannot be resumed";

const LABELS = {
  session: "Session",
  folder: "Folder",
  worked: "Worked",
  tokens: "Tokens",
  resume: "Resume",
} as const;

const LABEL_GAP = 2;

function labelColumn(): number {
  return Object.values(LABELS).reduce(
    (widest, label) => Math.max(widest, renderColumns(label)),
    0,
  );
}

function workedText(input: ExitSummaryInput, glyphs: Glyphs): string {
  const parts = [
    ...(input.durationMs > 0 ? [formatDurationMs(input.durationMs)] : []),
    plural(input.messages, "message"),
  ];
  return parts.join(` ${glyphs.bullet} `);
}

function notSavedText(glyphs: Glyphs): string {
  return `not saved ${glyphs.bullet} ${NOT_SAVED_TAIL}`;
}

interface InfoRow {
  readonly label: string;
  readonly value: string;
  readonly paint: Paint;
}

/** The widest value that must survive untouched: the command you copy. */
function hardValueWidth(input: ExitSummaryInput, glyphs: Glyphs): number {
  const value = input.resumable
    ? resumeCommand(input.sessionId)
    : notSavedText(glyphs);
  return labelColumn() + LABEL_GAP + renderColumns(value);
}

/** A dim label column beside its value, the way `/usage` and `clai keys` read. */
function infoLines(
  input: ExitSummaryInput,
  colors: Palette,
  glyphs: Glyphs,
  room: number,
  notes: string,
): InfoLine[] {
  const labelled = hardValueWidth(input, glyphs) <= room;
  const label = labelled ? labelColumn() : 0;
  const gap = " ".repeat(labelled ? LABEL_GAP : 0);
  const valueRoom = Math.max(6, room - label - gap.length);
  const title = input.title?.trim();
  const rows: InfoRow[] = [
    ...(title
      ? [
          {
            label: LABELS.session,
            value: truncateEnd(title, valueRoom),
            paint: colors.title,
          },
        ]
      : []),
    {
      label: LABELS.folder,
      value: shortenPath(input.cwd, valueRoom),
      paint: colors.value,
    },
    {
      label: LABELS.worked,
      value: truncateEnd(workedText(input, glyphs), valueRoom),
      paint: colors.value,
    },
    ...(notes.length > 0
      ? [
          {
            label: LABELS.tokens,
            value: truncateEnd(notes, valueRoom),
            paint: colors.muted,
          },
        ]
      : []),
    input.resumable
      ? {
          label: LABELS.resume,
          value: truncateEnd(resumeCommand(input.sessionId), valueRoom),
          paint: colors.command,
        }
      : {
          label: LABELS.resume,
          value: truncateEnd(notSavedText(glyphs), valueRoom),
          paint: colors.muted,
        },
  ];
  return rows.map((row) => {
    const shown = labelled ? padEnd(row.label, label) : "";
    return {
      plain: shown + gap + row.value,
      painted: colors.muted(shown) + gap + row.paint(row.value),
    };
  });
}

interface LogoBlock {
  readonly lines: readonly string[];
  readonly width: number;
}

const LOGO_SIZES: readonly WordmarkSize[] = ["large", "compact"];

function wordmarkBlock(unicode: boolean, size: WordmarkSize): LogoBlock {
  return {
    lines: renderWordmark("CLAI", {
      indent: "",
      style: unicode ? "block" : "ascii",
      size,
    }).split("\n"),
    width: wordmarkWidth("CLAI", size),
  };
}

/** The largest wordmark that still leaves the session lines their room. */
function logoBlock(
  unicode: boolean,
  available: number,
  colors: Palette,
): LogoBlock {
  for (const size of LOGO_SIZES) {
    if (wordmarkWidth("CLAI", size) <= available) {
      return wordmarkBlock(unicode, size);
    }
  }
  const text = "C L A I";
  return { lines: [colors.brand(text)], width: renderColumns(text) };
}

/** Logo on the left, session lines on the right, vertically centered. */
function sideBySide(
  logo: LogoBlock,
  info: readonly InfoLine[],
  gap: number,
): string[] {
  const offset = Math.max(0, Math.floor((logo.lines.length - info.length) / 2));
  const rows = Math.max(logo.lines.length, offset + info.length);
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const left = logo.lines[row];
    const right = info[row - offset];
    if (right === undefined || right.plain.length === 0) {
      lines.push(left === undefined ? "" : INDENT + left);
      continue;
    }
    const lead =
      left === undefined ? " ".repeat(logo.width) : padEnd(left, logo.width);
    lines.push(INDENT + lead + " ".repeat(gap) + right.painted);
  }
  return lines;
}

function stacked(logo: LogoBlock, info: readonly InfoLine[]): string[] {
  return [
    ...logo.lines.map((line) => INDENT + line),
    "",
    ...info.map((line) =>
      line.plain.length === 0 ? "" : INDENT + line.painted,
    ),
  ];
}

/**
 * Prefer the two-column banner, and within it the largest wordmark that leaves
 * the resume command whole; stack when nothing fits beside it.
 */
function bannerLines(
  input: ExitSummaryInput,
  colors: Palette,
  glyphs: Glyphs,
  available: number,
  notes: string,
): string[] {
  const required = Math.max(MIN_INFO, hardValueWidth(input, glyphs));
  for (const size of LOGO_SIZES) {
    const logo = wordmarkBlock(input.unicode, size);
    for (const gap of [LOGO_GAP, LOGO_GAP_TIGHT]) {
      const room = available - logo.width - gap;
      if (room >= required) {
        return sideBySide(
          logo,
          infoLines(input, colors, glyphs, room, notes),
          gap,
        );
      }
    }
  }
  const logo = logoBlock(input.unicode, available, colors);
  return stacked(logo, infoLines(input, colors, glyphs, available, notes));
}

function usageSection(
  input: ExitSummaryInput,
  colors: Palette,
  glyphs: Glyphs,
  available: number,
): string[] {
  if (input.usage.routes.length === 0) {
    return [
      INDENT +
        colors.muted(
          truncateEnd("No provider token usage was recorded.", available),
        ),
    ];
  }
  return tableLines(input.usage, available, colors, glyphs).map(
    (line) => INDENT + line,
  );
}

export function renderExitSummaryLines(input: ExitSummaryInput): string[] {
  const previousLevel = chalk.level;
  try {
    if (!input.color) chalk.level = 0;
    else if (chalk.level < 1) chalk.level = 3;
    return build(input);
  } finally {
    chalk.level = previousLevel;
  }
}

function build(input: ExitSummaryInput): string[] {
  const colors = palette(input.color);
  const glyphs = input.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
  const width = Math.max(MIN_WIDTH, Math.floor(input.width) || 80);
  const available = width - INDENT.length;
  const notes =
    input.usage.routes.length === 0
      ? ""
      : footnotes(input.usage.totals, glyphs).join(` ${glyphs.bullet} `);
  return [
    "",
    ...bannerLines(input, colors, glyphs, available, notes),
    "",
    ...usageSection(input, colors, glyphs, available),
    "",
  ];
}

export function renderExitSummary(input: ExitSummaryInput): string {
  return `${renderExitSummaryLines(input).join("\n")}\n`;
}
