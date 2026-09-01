import chalk, { type ChalkInstance } from "chalk";
import { visibleWidth, wrapAnsiLine } from "../markdown.js";
export { visibleWidth, wrapAnsiLine };

export function renderInlineMarkdown(
  text: string,
  paint: ChalkInstance = chalk,
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text.startsWith("``", i)) {
      const end = text.indexOf("``", i + 2);
      if (end > i + 2) {
        out += paint.cyan(`\`${text.slice(i + 2, end)}\``);
        i = end + 2;
        continue;
      }
    }

    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        out += paint.cyan(text.slice(i + 1, end));
        i = end + 1;
        continue;
      }
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

export const BR_RE_GLOBAL = /<br\s*\/?>/gi;

type ColumnAlign = "left" | "center" | "right";

export function isTableRowLine(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

export function isTableSeparatorLine(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") || !t.includes("-")) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
}

function splitTableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") {
      cur += "|";
      i++;
      continue;
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseColumnAligns(separator: string, columns: number): ColumnAlign[] {
  const cells = splitTableCells(separator);
  const aligns: ColumnAlign[] = [];
  for (let c = 0; c < columns; c++) {
    const cell = (cells[c] ?? "").trim();
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) aligns.push("center");
    else if (right) aligns.push("right");
    else aligns.push("left");
  }
  return aligns;
}

interface CellLine {
  rendered: string;
  width: number;
}

function padCell(
  rendered: string,
  contentWidth: number,
  columnWidth: number,
  align: ColumnAlign,
): string {
  const slack = Math.max(0, columnWidth - contentWidth);
  if (align === "right") return " ".repeat(slack) + rendered;
  if (align === "center") {
    const left = Math.floor(slack / 2);
    return " ".repeat(left) + rendered + " ".repeat(slack - left);
  }
  return rendered + " ".repeat(slack);
}

export function renderTableBlock(
  rawLines: string[],
  availWidth: number,
  paint: ChalkInstance,
): string[] {
  const separatorIndex = rawLines.findIndex(isTableSeparatorLine);
  const headerLines =
    separatorIndex > 0
      ? rawLines.slice(0, separatorIndex)
      : [rawLines[0] ?? ""];
  const separatorLine = separatorIndex >= 0 ? rawLines[separatorIndex]! : "";
  const bodyLines = (
    separatorIndex >= 0 ? rawLines.slice(separatorIndex + 1) : rawLines.slice(1)
  ).filter((l) => l.trim().length > 0);

  const headerCellRows = headerLines.map(splitTableCells);
  const bodyCellRows = bodyLines.map(splitTableCells);
  const columns = Math.max(
    1,
    ...headerCellRows.map((r) => r.length),
    ...bodyCellRows.map((r) => r.length),
  );
  const aligns = parseColumnAligns(separatorLine, columns);

  const toCell = (text: string): CellLine[] =>
    text.split(BR_RE_GLOBAL).map((part) => {
      const trimmed = part.trim();
      const bulletMatch = trimmed.match(/^([-\*+])\s+(.*)$/);
      if (bulletMatch) {
        const content = renderInlineMarkdown(bulletMatch[2]!, paint);
        const rendered = `${paint.cyan("•")} ${content}`;
        return { rendered, width: visibleWidth(rendered) };
      }
      const numberMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
      if (numberMatch) {
        const content = renderInlineMarkdown(numberMatch[2]!, paint);
        const rendered = `${paint.cyan(`${numberMatch[1]}.`)} ${content}`;
        return { rendered, width: visibleWidth(rendered) };
      }
      const rendered = renderInlineMarkdown(trimmed, paint);
      return { rendered, width: visibleWidth(rendered) };
    });

  const buildRow = (cells: string[]): CellLine[][] => {
    const row: CellLine[][] = [];
    for (let c = 0; c < columns; c++) row.push(toCell(cells[c] ?? ""));
    return row;
  };

  const headerRows = headerCellRows.map(buildRow);
  const bodyRows = bodyCellRows.map(buildRow);

  const colWidths = new Array<number>(columns).fill(1);
  for (const row of [...headerRows, ...bodyRows]) {
    for (let c = 0; c < columns; c++) {
      for (const cell of row[c] ?? []) {
        if (cell.width > colWidths[c]!) colWidths[c] = cell.width;
      }
    }
  }

  const budget = Math.max(columns, availWidth - (3 * columns + 1) - 1);
  let total = colWidths.reduce((a, b) => a + b, 0);
  while (total > budget) {
    let widest = 0;
    for (let c = 1; c < columns; c++) {
      if (colWidths[c]! > colWidths[widest]!) widest = c;
    }
    if (colWidths[widest]! <= 1) break;
    colWidths[widest]!--;
    total--;
  }

  const wrapCell = (cell: CellLine[], width: number): CellLine[] => {
    const out: CellLine[] = [];
    for (const line of cell) {
      for (const piece of wrapAnsiLine(line.rendered, width)) {
        const trimmed = piece.replace(/ +$/, "");
        out.push({ rendered: trimmed, width: visibleWidth(trimmed) });
      }
    }
    return out.length > 0 ? out : [{ rendered: "", width: 0 }];
  };

  const dim = paint.dim;
  const renderRow = (row: CellLine[][], bold: boolean): string[] => {
    const wrapped = row.map((cell, c) => wrapCell(cell, colWidths[c]!));
    const height = Math.max(1, ...wrapped.map((w) => w.length));
    const lines: string[] = [];
    for (let h = 0; h < height; h++) {
      let s = dim("│");
      for (let c = 0; c < columns; c++) {
        const piece = wrapped[c]![h] ?? { rendered: "", width: 0 };
        const content =
          bold && piece.rendered ? paint.bold(piece.rendered) : piece.rendered;
        s +=
          " " +
          padCell(content, piece.width, colWidths[c]!, aligns[c]!) +
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
  for (const row of headerRows) out.push(...renderRow(row, true));
  out.push(border("├", "┼", "┤"));
  for (let i = 0; i < bodyRows.length; i++) {
    if (i > 0) {
      const spacer = Array.from({ length: columns }, () => [
        { rendered: "", width: 0 },
      ]);
      out.push(...renderRow(spacer, false));
    }
    out.push(...renderRow(bodyRows[i]!, false));
  }
  out.push(border("└", "┴", "┘"));
  return out;
}
