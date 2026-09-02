import { usageCacheHitRate } from "../../../app/controllers/session-usage-ledger.js";
import type { SessionUsageReport, SessionUsageRoute, SessionUsageTotals } from "../../../app/controllers/session-usage-ledger.js";
import { renderColumns } from "../text-width.js";

const MIN_LABEL_COLUMNS = 10;

const COLUMN_GAP = 2;

const LABEL_HEADERS = ["PROVIDER / MODEL", "PROVIDER/MODEL", "MODEL"] as const;

const METRIC_COLUMNS = ["REQ", "IN", "OUT", "TOTAL", "CACHE"] as const;

type MetricColumn = (typeof METRIC_COLUMNS)[number];

const DROP_ORDER: readonly MetricColumn[] = ["CACHE", "OUT", "IN", "REQ", "TOTAL"];

export type Paint = (text: string) => string;

export interface Palette {
  readonly brand: Paint;
  readonly title: Paint;
  readonly muted: Paint;
  readonly label: Paint;
  readonly value: Paint;
  readonly total: Paint;
  readonly command: Paint;
}

export const IDENTITY: Paint = (text) => text;

export interface Glyphs {
  readonly horizontal: string;
  readonly bullet: string;
  readonly missing: string;
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

function percent(value: number | undefined, glyphs: Glyphs): string {
  if (value === undefined) return glyphs.missing;
  const scaled = value * 100;
  if (scaled > 0 && scaled < 0.1) return "<0.1%";
  return `${scaled.toFixed(1)}%`;
}

export function plural(value: number, singular: string): string {
  return `${count(value)} ${singular}${value === 1 ? "" : "s"}`;
}

export function truncateEnd(text: string, width: number): string {
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

export function truncateMiddle(text: string, width: number): string {
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

export function padEnd(text: string, width: number): string {
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

export function tableLines(
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
