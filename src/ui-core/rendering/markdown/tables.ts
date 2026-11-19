import chalk, { type ChalkInstance } from "chalk";
import { terminalWidth } from "../text-width.js";
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
const EMPTY_CELL_LINE: CellLine = { rendered: "", width: 0 };

function cellLine(rendered: string): CellLine {
  return { rendered, width: terminalWidth(rendered) };
}

function padCell(
  rendered: string,
  contentWidth: number,
  columnWidth: number,
  align: TableHeader["aligns"][number],
): string {
  const slack = Math.max(0, columnWidth - contentWidth);
  if (align === "right") return " ".repeat(slack) + rendered;
  if (align === "center") {
    const left = Math.floor(slack / 2);
    return " ".repeat(left) + rendered + " ".repeat(slack - left);
  }
  return rendered + " ".repeat(slack);
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

export function renderTableBlock(
  header: TableHeader,
  rows: readonly string[][],
  availWidth: number,
  paint: ChalkInstance,
  wrap: WrapCellLine,
): string[] {
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
  const colWidths = fitColumns(preferred, availWidth - 3 * columns - 2);
  if (!colWidths) return renderStackedRows(headerRow, bodyRows, availWidth, paint, wrap);

  const wrapCell = (cell: CellLine[], width: number): CellLine[] => {
    const out: CellLine[] = [];
    for (const line of cell) {
      for (const piece of wrap(line.rendered, width)) {
        const trimmed = piece.replace(/ +$/, "");
        out.push(cellLine(trimmed));
      }
    }
    return out;
  };

  const dim = paint.dim;
  const renderRow = (row: CellLine[][], bold: boolean): string[] => {
    const wrapped = row.map((cell, c) => wrapCell(cell, colWidths[c]!));
    const height = wrapped.reduce((max, cell) => Math.max(max, cell.length), 1);
    const lines: string[] = [];
    for (let h = 0; h < height; h++) {
      let s = dim("│");
      for (let c = 0; c < columns; c++) {
        const piece = wrapped[c]![h] ?? EMPTY_CELL_LINE;
        const content =
          bold && piece.rendered ? paint.bold(piece.rendered) : piece.rendered;
        s +=
          " " +
          padCell(content, piece.width, colWidths[c]!, header.aligns[c]!) +
          " " +
          dim("│");
      }
      lines.push(s);
    }
    return lines;
  };

  const border = (left: string, mid: string, right: string): string => {
    let s = left;
    for (let c = 0; c < columns; c++) {
      s += "─".repeat(colWidths[c]! + 2);
      s += c < columns - 1 ? mid : right;
    }
    return dim(s);
  };

  const out: string[] = [border("┌", "┬", "┐")];
  for (const line of renderRow(headerRow, true)) out.push(line);
  if (bodyRows.length > 0) out.push(border("├", "┼", "┤"));
  const spacer = dim("│") + colWidths.map((width) => " ".repeat(width + 2) + dim("│")).join("");
  for (let i = 0; i < bodyRows.length; i++) {
    if (i > 0) out.push(spacer);
    for (const line of renderRow(bodyRows[i]!, false)) out.push(line);
  }
  out.push(border("└", "┴", "┘"));
  return out;
}
