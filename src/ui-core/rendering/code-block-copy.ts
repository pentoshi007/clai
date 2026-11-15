import { CODE_BLOCK_COPY_LABEL, CODE_BLOCK_WRAP_MARK } from "./code-block.js";
import { renderColumns } from "./text-width.js";

type LineKind = "top" | "bottom" | "row" | "other";

const TOP = /^[^│╭╮╰╯]*╭─.*╮\s*$/;
const BOTTOM = /^\s*╰[─┴]*╯\s*$/;
const ROW = /^\s*│ (.*)│\s*$/;
const HEAD_ROW = /^([^│]*?)\s*│\s*$/;
const TAIL_ROW = /^\s*│ ([^│]*)$/;
const PARTIAL_TOP = /^[^│╭╰╯]*─[^│╭╰╯]*╮\s*$/;
const PARTIAL_BOTTOM = /^\s*╰[─┴]*$/;
const WRAP_PREFIX = new RegExp(`^ *${CODE_BLOCK_WRAP_MARK}`);
const COPY_TAB = new RegExp(`─ ${CODE_BLOCK_COPY_LABEL} ─╮\\s*$`);

const kindOf = (line: string): LineKind =>
  TOP.test(line) ? "top" : BOTTOM.test(line) ? "bottom" : ROW.test(line) ? "row" : "other";

const isFrame = (line: string): boolean => {
  const kind = kindOf(line);
  return kind === "top" || kind === "bottom";
};

const columns = (line: string): number => renderColumns(line.slice(Math.max(0, line.search(/[╭│╰]/))).trimEnd());

const borderCount = (line: string): number => line.split("│").length - 1;

const rowBody = (line: string): string => (ROW.exec(line)?.[1] ?? "").trimEnd();

const headBody = (line: string): string | undefined =>
  borderCount(line) === 1 ? HEAD_ROW.exec(line)?.[1] : undefined;

const tailBody = (line: string): string | undefined =>
  TAIL_ROW.exec(line)?.[1]?.trimEnd();

function joinWrapped(bodies: readonly string[]): string[] {
  const lines: string[] = [];
  for (const [index, body] of bodies.entries()) {
    if (index > 0 && WRAP_PREFIX.test(body)) {
      lines[lines.length - 1] += body.replace(WRAP_PREFIX, "");
    } else {
      lines.push(index === 0 ? body.replace(WRAP_PREFIX, "") : body);
    }
  }
  return lines;
}

interface RegionOptions {
  readonly width: number | undefined;
  readonly head: boolean;
  readonly openEnd: boolean;
}

interface Region {
  readonly lines: string[];
  readonly next: number;
  readonly closed: boolean;
}

function readRegion(
  lines: readonly string[],
  from: number,
  options: RegionOptions,
): Region | undefined {
  const bodies: string[] = [];
  let width = options.width;
  const last = lines.length - 1;
  for (let index = from; index <= last; index += 1) {
    const line = lines[index]!;
    const kind = kindOf(line);
    if (kind === "bottom") {
      if (width !== undefined && columns(line) !== width) return undefined;
      return { lines: joinWrapped(bodies), next: index + 1, closed: true };
    }
    if (kind === "row") {
      width ??= columns(line);
      if (columns(line) !== width) return undefined;
      bodies.push(rowBody(line));
      continue;
    }
    const head = options.head && index === from ? headBody(line) : undefined;
    if (head !== undefined) {
      bodies.push(head);
      continue;
    }
    if (index === last) {
      if (PARTIAL_BOTTOM.test(line)) return { lines: joinWrapped(bodies), next: index + 1, closed: false };
      const tail = tailBody(line);
      if (tail !== undefined) {
        bodies.push(tail);
        return { lines: joinWrapped(bodies), next: index + 1, closed: false };
      }
    }
    return undefined;
  }
  return options.openEnd ? { lines: joinWrapped(bodies), next: lines.length, closed: false } : undefined;
}

function decodeUnframed(lines: readonly string[]): string[] | undefined {
  const last = lines.length - 1;
  const bodies: string[] = [];
  let width: number | undefined;
  for (const [index, line] of lines.entries()) {
    if (kindOf(line) === "row" && borderCount(line) === 2) {
      width ??= columns(line);
      if (columns(line) !== width) return undefined;
      bodies.push(rowBody(line));
      continue;
    }
    const head = index === 0 ? headBody(line) : undefined;
    const tail = index === last && (index > 0 || last === 0) ? tailBody(line) : undefined;
    const body = head ?? tail;
    if (body === undefined) return undefined;
    bodies.push(body);
  }
  return joinWrapped(bodies);
}

export function copyableSelectionText(text: string): string {
  if (!text.includes("│")) return text;
  const lines = text.split("\n");
  if (!lines.some(isFrame)) return decodeUnframed(lines)?.join("\n") ?? text;

  const out: string[] = [];
  let index = 0;
  const lead =
    lines.length > 1 && PARTIAL_TOP.test(lines[0]!)
      ? readRegion(lines, 1, { width: undefined, head: false, openEnd: true })
      : kindOf(lines.find(isFrame)!) === "bottom"
        ? readRegion(lines, 0, { width: undefined, head: true, openEnd: false })
        : undefined;
  if (lead) {
    out.push(...lead.lines);
    index = lead.next;
  }
  while (index < lines.length) {
    const line = lines[index]!;
    const region = kindOf(line) === "top"
      ? readRegion(lines, index + 1, { width: columns(line), head: false, openEnd: true })
      : undefined;
    if (region) {
      out.push(...region.lines);
      index = region.next;
      continue;
    }
    out.push(line);
    index += 1;
  }
  return out.join("\n");
}

export function codeBlockCopyAt(
  lines: readonly string[],
  lineIndex: number,
  column: number,
): string | undefined {
  const header = lines[lineIndex];
  if (header === undefined || kindOf(header) !== "top") return undefined;
  const tab = COPY_TAB.exec(header);
  if (!tab) return undefined;
  const start = renderColumns(header.slice(0, tab.index + 1));
  if (column < start || column >= start + CODE_BLOCK_COPY_LABEL.length + 2) return undefined;
  const region = readRegion(lines, lineIndex + 1, { width: columns(header), head: false, openEnd: false });
  return region?.closed ? region.lines.join("\n") : undefined;
}
