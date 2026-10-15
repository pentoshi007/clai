import type { Theme } from "./theme.js";
import { isCodeFenceClose, matchCodeFenceOpen } from "./code-block.js";
import { fitOneLine, wrapPagerLine } from "./pager-chrome.js";
import { TOOL_USAGE_LINE } from "./tool-usage-label.js";
import { renderMarkdownLines, type RenderMarkdownLinesOptions } from "./render-markdown-lines.js";

export interface SubagentSpan {
  readonly text: string;
  readonly fg: keyof Theme;
  readonly bold?: boolean;
}

function statusColor(status: string): keyof Theme {
  if (/^(?:✓|completed|complete|succeeded)$/i.test(status)) return "success";
  if (/^(?:✗|failed|error)$/i.test(status)) return "diffDel";
  return "activity";
}

export const SUBAGENT_TOOL_CONTINUATION_INDENT = "  ";

const READ_USAGE_RE = /^(\s{2,}(?:└\s+)?)(Read)(\s+)(✗\s+)?(.*)$/;
const TOOL_OUTCOME_RE = /^\s*(?:✗\s|In progress\b|No result recorded|Denied\b|Failed\b)/;

function isToolContinuation(line: string): boolean {
  return line.startsWith(SUBAGENT_TOOL_CONTINUATION_INDENT) && !TOOL_OUTCOME_RE.test(line);
}

export function subagentLineSpans(line: string): readonly SubagentSpan[] | undefined {
  const tool = TOOL_USAGE_LINE.exec(line);
  if (tool) {
    const color = statusColor(tool[2]!);
    return [
      { text: `${tool[1]}${tool[2]}${tool[3]}`, fg: color },
      { text: tool[4]!, fg: color, bold: true },
      { text: tool[5]!, fg: "inputBorder" },
    ];
  }
  const read = READ_USAGE_RE.exec(line);
  if (read) {
    return [
      { text: `${read[1]}${read[2]}${read[3]}`, fg: "toolOutput" },
      { text: `${read[4] ?? ""}${read[5]}`, fg: read[4] ? "diffDel" : "inputBorder" },
    ];
  }
  const status = /^(\s*)(running|stopping|stopped|completed|partial|failed|error)(\s+·.*)$/.exec(line);
  if (status) {
    return [
      { text: `${status[1]}${status[2]}`, fg: statusColor(status[2]!), bold: true },
      { text: status[3]!, fg: "muted" },
    ];
  }
  const reportStatus = /^(\s*Status:\s*)(complete|completed|partial|failed|error|stopped)(\b.*)$/i.exec(line);
  if (reportStatus) {
    return [
      { text: reportStatus[1]!, fg: "cyan" },
      { text: reportStatus[2]!, fg: statusColor(reportStatus[2]!), bold: true },
      { text: reportStatus[3]!, fg: "muted" },
    ];
  }
  const metadata = /^(\s*(?:Workspace|Agent|Recovery):)(.*)$/.exec(line);
  if (metadata) {
    return [
      { text: metadata[1]!, fg: "cyan" },
      { text: metadata[2]!, fg: "muted" },
    ];
  }
  if (/^\s*(?:#{1,6}\s+)?(?:Error|Stopped|Partial report)\b/.test(line)) {
    return [{ text: line, fg: /\bError\b/.test(line) ? "diffDel" : "activity", bold: true }];
  }
  if (/^\s*#{1,6}\s+/.test(line) || /^\s*(?:Assignment|Context|Activity|Report|Findings|Evidence|Next steps|Coverage gaps)\s*$/.test(line)) {
    return [{ text: line, fg: "magenta", bold: true }];
  }
  if (/^\s*(?:✗\s|Denied\b|Failed\b)/.test(line)) return [{ text: line, fg: "diffDel" }];
  if (/^\s*✓\s/.test(line)) return [{ text: line, fg: "success" }];
  if (/^\s*(?:→\s|Notice:|In progress\b|Waiting for the first update)/.test(line)) {
    return [{ text: line, fg: "activity" }];
  }
  if (/^\s*(?:No result recorded|No activity recorded)/.test(line)) return [{ text: line, fg: "muted" }];
  return undefined;
}

export function subagentBodySpans(
  lines: readonly string[],
): readonly (readonly SubagentSpan[] | undefined)[] {
  let inToolCall = false;
  return lines.map((line) => {
    const semantic = subagentLineSpans(line);
    if (inToolCall && isToolContinuation(line)) return semantic ?? [{ text: line, fg: "inputBorder" }];
    inToolCall = TOOL_USAGE_LINE.test(line);
    return semantic;
  });
}

export type SubagentSpanPaint = (span: SubagentSpan) => string;

function compactToolRow(line: string, spans: readonly SubagentSpan[], width: number, paint: SubagentSpanPaint): string {
  const fitted = fitOneLine([line], width);
  const clipped = fitted !== line;
  let remaining = fitted.length - (clipped ? 1 : 0);
  let row = "";
  for (const span of spans) {
    if (remaining <= 0) break;
    const text = span.text.slice(0, remaining);
    row += paint({ ...span, text });
    remaining -= text.length;
  }
  return clipped ? row + paint({ text: "…", fg: "hint" }) : row;
}

export function renderSubagentMarkdownLines(
  body: string,
  options: RenderMarkdownLinesOptions,
  paint: SubagentSpanPaint,
): string[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const spans = subagentBodySpans(lines);
  const rendered: string[] = [];
  const prose: string[] = [];
  let fence: string | undefined;
  const flushProse = (): void => {
    if (prose.length === 0) return;
    const rows = renderMarkdownLines(prose.join("\n"), options);
    rendered.push(...(rows.length > 0 ? rows : prose.map((line) => line || " ")));
    prose.length = 0;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const semantic = fence ? undefined : spans[index];
    if (!semantic) {
      prose.push(line);
      if (fence) {
        if (isCodeFenceClose(line, fence)) fence = undefined;
      } else {
        fence = matchCodeFenceOpen(line)?.marker;
      }
      continue;
    }
    flushProse();
    if (TOOL_USAGE_LINE.test(line) || READ_USAGE_RE.test(line)) {
      rendered.push(compactToolRow(line, semantic, options.width, paint));
      continue;
    }
    let offset = 0;
    for (const chunk of wrapPagerLine(line, options.width, { preserveWhitespace: true })) {
      const end = offset + chunk.length;
      let spanOffset = 0;
      let row = "";
      for (const span of semantic) {
        const next = spanOffset + span.text.length;
        if (next > offset && spanOffset < end) {
          row += paint({ ...span, text: span.text.slice(Math.max(0, offset - spanOffset), Math.min(span.text.length, end - spanOffset)) });
        }
        spanOffset = next;
        if (spanOffset >= end) break;
      }
      rendered.push(row || " ");
      offset = end;
    }
  }
  flushProse();
  return rendered;
}

export function styleSubagentBody(body: string, paint: SubagentSpanPaint): string {
  const lines = body.split("\n");
  const spans = subagentBodySpans(lines);
  return lines
    .map((line, index) => spans[index]?.map(paint).join("") ?? line)
    .join("\n");
}
