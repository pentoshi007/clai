import chalk, { type ChalkInstance } from "chalk";
import { terminalWidth } from "../text-width.js";
import { stripAnsiSequences } from "../sanitize-display.js";
import { backtickRunEnd, matchCodeSpan } from "./code-spans.js";
import { splitMarkdownBreaks } from "./markup.js";
import type { TableHeader } from "./table-syntax.js";

const ESCAPABLE = /[!-/:-@\x5b-\x60{-~]/;

export function renderInlineMarkdown(
  text: string,
  paint: ChalkInstance = chalk,
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && ESCAPABLE.test(text[i + 1] ?? "")) {
      out += text[i + 1];
      i += 2;
      continue;
    }

    if (text[i] === "`") {
      const openEnd = backtickRunEnd(text, i);
      const span = matchCodeSpan(text, i, openEnd);
      if (span) {
        const content = span.content;
        const padded = content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content);
        out += paint.cyan(padded ? content.slice(1, -1) : content);
      } else out += text.slice(i, openEnd);
      i = span?.end ?? openEnd;
      continue;
    }

    if (text.startsWith("***", i)) {
      const end = text.indexOf("***", i + 3);
      if (end > i + 3) {
        out += paint.bold.italic(renderInlineMarkdown(text.slice(i + 3, end), paint));
        i = end + 3;
        continue;
      }
    }

    if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end > i + 2) {
        out += paint.bold(renderInlineMarkdown(text.slice(i + 2, end), paint));
        i = end + 2;
        continue;
      }
    }

    if (text.startsWith("__", i)) {
      const end = text.indexOf("__", i + 2);
      if (end > i + 2) {
        out += paint.bold(renderInlineMarkdown(text.slice(i + 2, end), paint));
        i = end + 2;
        continue;
      }
    }

    if (text[i] === "*" && text[i + 1] !== "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1 && text[end + 1] !== "*") {
        const inner = text.slice(i + 1, end);
        if (
          inner.length > 0 &&
          !inner.startsWith(" ") &&
          !inner.endsWith(" ")
        ) {
          out += paint.italic(renderInlineMarkdown(inner, paint));
          i = end + 1;
          continue;
        }
      }
    }

    if (text[i] === "_") {
      const prev = text[i - 1];
      const isWordBoundary = !prev || /[\s\W]/.test(prev);
      if (isWordBoundary) {
        const end = text.indexOf("_", i + 1);
        if (end > i + 1) {
          const after = text[end + 1];
          const isAfterBoundary = !after || /[\s\W]/.test(after);
          const inner = text.slice(i + 1, end);
          if (
            isAfterBoundary &&
            inner.length > 0 &&
            !inner.startsWith(" ") &&
            !inner.endsWith(" ")
          ) {
            out += paint.italic(renderInlineMarkdown(inner, paint));
            i = end + 1;
            continue;
          }
        }
      }
    }

    if (text.startsWith("~~", i)) {
      const end = text.indexOf("~~", i + 2);
      if (end > i + 2) {
        out += paint.strikethrough(
          renderInlineMarkdown(text.slice(i + 2, end), paint),
        );
        i = end + 2;
        continue;
      }
    }

    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i && text[close + 1] === "(") {
        const urlEnd = text.indexOf(")", close + 2);
        if (urlEnd > close + 2) {
          const label = text.slice(i + 1, close);
          const url = text.slice(close + 2, urlEnd);
          out += paint.cyan.underline(label) + paint.dim(`(${url})`);
          i = urlEnd + 1;
          continue;
        }
      }
    }

    out += text[i];
    i += 1;
  }
  return out;
}

interface CellLine {
  rendered: string;
  width: number;
}

type WrapCellLine = (line: string, width: number) => string[];
export interface TablePiece extends CellLine {
  readonly inset: number;
  readonly before: string;
}

export interface TableColumn {
  readonly width: number;
  readonly pieces: readonly TablePiece[];
}

export interface TableGridRow {
  readonly divider: string;
  readonly columns: readonly TableColumn[];
  readonly height: number;
}

function cellLine(rendered: string): CellLine {
  return { rendered, width: terminalWidth(rendered) };
}

function leftInset(slack: number, align: TableHeader["aligns"][number]): number {
  if (align === "right") return slack;
  return align === "center" ? Math.floor(slack / 2) : 0;
}

export function tableRowLines(row: TableGridRow): string[] {
  return Array.from({ length: row.height }, (_, index) => row.divider + row.columns.map(column => {
    const piece = column.pieces[index];
    const left = piece?.inset ?? 0;
    const right = Math.max(0, column.width - left - (piece?.width ?? 0));
    return " ".repeat(left + 1) + (piece?.rendered ?? "") + " ".repeat(right + 1) + row.divider;
  }).join(""));
}

function fitColumns(preferred: number[], budget: number): number[] | undefined {
  const minimum = preferred.reduce((total, width) => total + Math.min(2, width), 0);
  if (minimum > budget) return undefined;
  if (preferred.reduce((total, width) => total + width, 0) <= budget) return preferred;

  let low = 2;
  let high = budget;
  while (low < high) {
    const cap = Math.ceil((low + high) / 2);
    const total = preferred.reduce((sum, width) => sum + Math.min(cap, width), 0);
    if (total <= budget) low = cap;
    else high = cap - 1;
  }

  const widths = preferred.map((width) => Math.min(low, width));
  let spare = budget - widths.reduce((total, width) => total + width, 0);
  for (let i = widths.length - 1; i >= 0 && spare > 0; i -= 1) {
    if (widths[i]! < preferred[i]!) {
      widths[i]! += 1;
      spare -= 1;
    }
  }
  return widths;
}

function renderCell(text: string, paint: ChalkInstance): CellLine[] {
  return splitMarkdownBreaks(text, "\n").map((part) => {
    const trimmed = part.trim();
    const list = /^(?<marker>[-*+]|\d+[.)])[ \t]+(?<content>.*)$/.exec(trimmed)?.groups;
    const rendered = list
      ? `${paint.cyan(list.marker!.length === 1 ? "•" : list.marker!)} ${renderInlineMarkdown(list.content!, paint)}`
      : renderInlineMarkdown(trimmed, paint);
    return cellLine(rendered.replaceAll("\t", "    "));
  });
}

function renderStackedRows(
  header: readonly CellLine[][],
  rows: readonly CellLine[][][],
  width: number,
  paint: ChalkInstance,
  wrap: WrapCellLine,
): string[] {
  const labels = header.map((cell) => paint.bold(cell.map(({ rendered }) => rendered).join(" ").trim()));
  if (rows.length === 0) return labels.flatMap((label) => wrap(label, width));

  const out: string[] = [];
  for (const row of rows) {
    if (out.length > 0) out.push("");
    for (const [column, cell] of row.entries()) {
      const [first, ...rest] = cell;
      const field = [labels[column], first?.rendered].filter(Boolean).join("  ");
      if (field) out.push(...wrap(field, width));
      for (const line of rest) {
        for (const chunk of wrap(line.rendered, width - 2)) out.push(`  ${chunk}`);
      }
    }
  }
  return out;
}

function wrapColumn(
  lines: CellLine[], width: number, align: TableHeader["aligns"][number],
  wrap: WrapCellLine, style: (text: string) => string,
): TableColumn {
  const pieces = lines.flatMap((line, lineIndex) => {
    const source = stripAnsiSequences(line.rendered);
    let end = 0;
    return wrap(line.rendered, width).map((chunk, index) => {
      const rendered = style(chunk.replace(/ +$/, ""));
      const text = stripAnsiSequences(rendered);
      const start = source.indexOf(text, end);
      const before = index === 0 && lineIndex > 0 ? "\n" : source.slice(end, start);
      end = start + text.length;
      const size = terminalWidth(rendered);
      return { rendered, width: size, inset: leftInset(Math.max(0, width - size), align), before };
    });
  });
  return { width, pieces };
}

export function layoutTableBlock(
  header: TableHeader, rows: readonly string[][], availWidth: number, paint: ChalkInstance, wrap: WrapCellLine,
): (string | TableGridRow)[] {
  const columns = header.cells.length;
  const preferred = new Array<number>(columns).fill(1);
  const buildRow = (cells: readonly string[]): CellLine[][] => header.cells.map((_, column) => {
    const source = column === columns - 1 && cells.length > columns
      ? cells.slice(column).join(" | ")
      : cells[column] ?? "";
    const lines = renderCell(source, paint);
    for (const cell of lines) preferred[column] = Math.max(preferred[column]!, cell.width);
    return lines;
  });
  const headerRow = buildRow(header.cells);
  const bodyRows = rows.map(buildRow);
  const widths = fitColumns(preferred, availWidth - 3 * columns - 2);
  if (!widths) return renderStackedRows(headerRow, bodyRows, availWidth, paint, wrap);

  const divider = paint.dim("│");
  const gridRow = (row: CellLine[][], style: (text: string) => string): TableGridRow => {
    const cells = row.map((cell, i) => wrapColumn(cell, widths[i]!, header.aligns[i]!, wrap, style));
    return { divider, columns: cells, height: cells.reduce((max, cell) => Math.max(max, cell.pieces.length), 1) };
  };
  const border = (left: string, mid: string, right: string): string =>
    paint.dim(left + widths.map(width => "─".repeat(width + 2)).join(mid) + right);
  const out: (string | TableGridRow)[] = [border("┌", "┬", "┐"), gridRow(headerRow, paint.bold)];
  if (bodyRows.length) out.push(border("├", "┼", "┤"));
  const spacer = divider + widths.map(width => " ".repeat(width + 2) + divider).join("");
  for (const [i, row] of bodyRows.entries()) {
    if (i > 0) out.push(spacer);
    out.push(gridRow(row, text => text));
  }
  out.push(border("└", "┴", "┘"));
  return out;
}

export function flatMarkdownPart(part: string | TableGridRow): string | string[] {
  return typeof part === "string" ? part : tableRowLines(part);
}

export function renderTableBlock(...args: Parameters<typeof layoutTableBlock>): string[] {
  return layoutTableBlock(...args).flatMap(flatMarkdownPart);
}
