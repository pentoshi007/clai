import chalk from "chalk";
import type { TranscriptItem, ToolItem, TuiState, CompactedItem } from "./state.js";
import { renderMarkdown, wrapAnsiLine } from "../ui/markdown.js";
import { renderPlanChecklist } from "../ui/plan-pane.js";
import { safeCwd } from "../os/cwd.js";

// ── Batch section parser ──────────────────────────────────────────────────────

interface BatchSection {
  index: number;
  name: string;
  ok: boolean;
  exitCode?: number;
  body: string;
}

/**
 * Split a completed tool.batch output into per-sub-tool sections.
 * Each section is delimited by a header line like:
 *   ── #1 dns.lookup [ok exit=0]
 *   ── #2 web.fetch [fail exit=1]
 */
function parseBatchSections(output: string): BatchSection[] {
  const headerRe = /^──\s+#(\d+)\s+([\w.]+)\s+\[(ok|fail)(?:\s+exit=(\d+))?\]/;
  const sections: BatchSection[] = [];
  let current: BatchSection | null = null;
  const bodyLines: string[] = [];

  for (const line of output.split("\n")) {
    const m = headerRe.exec(line);
    if (m) {
      if (current !== null) {
        current.body = bodyLines.join("\n").trim();
        sections.push(current);
        bodyLines.length = 0;
      }
      const exitCode = m[4] !== undefined ? parseInt(m[4], 10) : undefined;
      current = {
        index: parseInt(m[1]!, 10),
        name: m[2]!,
        ok: m[3] === "ok",
        ...(exitCode !== undefined ? { exitCode } : {}),
        body: "",
      };
    } else if (current !== null) {
      bodyLines.push(line);
    }
  }
  if (current !== null) {
    current.body = bodyLines.join("\n").trim();
    sections.push(current);
  }
  return sections;
}

/**
 * Render a single batch sub-tool section as indented lines with its own
 * status glyph, name, and collapsed/expanded body — nested inside the
 * parent batch card.
 */
function renderBatchSection(
  section: BatchSection,
  bar: (s: string) => string,
  ctx: RenderCtx,
): string[] {
  const subColor = section.ok ? chalk.green : chalk.red;
  const glyph = section.ok ? chalk.green("✓") : chalk.red("✗");
  const exitSuffix =
    typeof section.exitCode === "number" && section.exitCode !== 0
      ? chalk.red(` (exit ${section.exitCode})`)
      : "";
  const subHeader =
    bar("") +
    chalk.dim("  ") +
    subColor("┌ ") +
    glyph +
    " " +
    chalk.bold(section.name) +
    exitSuffix;
  const subBar = bar("") + chalk.dim("  ") + subColor("│ ");
  const subBottom = bar("") + chalk.dim("  ") + subColor("└");

  const lines: string[] = [subHeader];

  if (section.body) {
    const rawLines = section.body.split("\n");
    const wrappedLines: string[] = [];
    for (const raw of rawLines) {
      wrappedLines.push(...wrapAnsiLine(raw, Math.max(10, ctx.width - 8)));
    }
    const COLLAPSED = 3;
    const shown = ctx.outputExpanded
      ? wrappedLines
      : wrappedLines.slice(0, COLLAPSED);
    const hidden = wrappedLines.length - shown.length;
    for (const wl of shown) {
      lines.push(subBar + chalk.dim(wl));
    }
    if (hidden > 0) {
      lines.push(
        subBottom +
          chalk.dim(` +${hidden} more line(s) · ctrl+o to expand`),
      );
    } else {
      lines.push(subBottom);
    }
  } else {
    lines.push(subBottom);
  }
  return lines;
}

export interface RenderCtx {
  width: number;
  thinkingExpanded: boolean;
  outputExpanded: boolean;
  running: boolean;
  version?: string | undefined;
  mode?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
}

const COLLAPSED_OUTPUT_LINES = 3;

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    out.push(...wrapAnsiLine(line, Math.max(10, width)));
  }
  return out;
}

function statusGlyph(status: ToolItem["status"]): string {
  switch (status) {
    case "running":
      return chalk.yellow("●");
    case "ok":
      return chalk.green("✓");
    case "fail":
      return chalk.red("✗");
    case "blocked":
      return chalk.red("⊘");
  }
}

function gutterColor(status: ToolItem["status"]): (s: string) => string {
  switch (status) {
    case "running":
      return chalk.yellow;
    case "ok":
      return chalk.green;
    case "fail":
    case "blocked":
      return chalk.red;
  }
}

function stripStreamingToolFence(text: string): string {
  const indicators = [
    "```tool",
    "```json",
    "<tool",
    "<|tool",
    "<|",
  ];

  let minIdx = -1;
  for (const ind of indicators) {
    const idx = text.indexOf(ind);
    if (idx >= 0 && (minIdx === -1 || idx < minIdx)) {
      minIdx = idx;
    }
  }

  // Code blocks: ``` followed by tool, json, newline, or end of string
  const matchCode = /```(?:tool|json|\n|$)/i.exec(text);
  if (matchCode) {
    const idx = matchCode.index;
    if (minIdx === -1 || idx < minIdx) {
      minIdx = idx;
    }
  }

  // Raw JSON block start '{' if preceded by whitespace/newline or start of string
  const jsonMatch = /(?:^|\s)\{/.exec(text);
  if (jsonMatch) {
    const idx = jsonMatch.index + jsonMatch[0].indexOf("{");
    if (minIdx === -1 || idx < minIdx) {
      minIdx = idx;
    }
  }

  if (minIdx >= 0) {
    return text.slice(0, minIdx);
  }
  return text;
}

function renderUser(text: string, width: number): string[] {
  const tag = chalk.bgHex("#22D3EE").hex("#020617").bold(" you ");
  const md = renderMarkdown(text).replace(/\n+$/, "");
  const lines = md.split("\n").map((line) => line.startsWith("  ") ? line.slice(2) : line);
  const out: string[] = [];
  for (const line of lines) {
    out.push(...wrap(line, width - 8));
  }
  return out.map((l, i) => {
    const whiteLine = "\x1b[38;2;255;255;255m" + l.replace(/\x1b\[39m/g, "\x1b[38;2;255;255;255m") + "\x1b[39m";
    return i === 0 ? `${tag} ${whiteLine}` : `      ${whiteLine}`;
  });
}

function renderAssistant(text: string, width: number): string[] {
  const label = chalk.magenta.bold("◆ Response");
  const md = renderMarkdown(text).replace(/\n+$/, "");
  return [label, ...md.split("\n").map((line) => `  ${line}`)];
}

function renderThinking(content: string, ctx: RenderCtx): string[] {
  if (!ctx.thinkingExpanded) {
    return [chalk.dim.italic("✦ thinking") + chalk.dim(" · ctrl+t or /think to view")];
  }
  const head = chalk.dim.italic("✦ thinking");
  const body = wrap(content.trim(), ctx.width - 4).map((l) => chalk.dim("  " + l));
  return [head, ...body];
}

function renderTool(item: ToolItem, ctx: RenderCtx): string[] {
  const color = gutterColor(item.status);
  const bar = color("│ ");
  const top = color("╭ ");
  const bottom = color("╰ ");

  const header =
    top +
    statusGlyph(item.status) +
    " " +
    chalk.bold.cyan(item.name) +
    (typeof item.exitCode === "number" && item.exitCode !== 0
      ? chalk.red(`  (exit ${item.exitCode})`)
      : "");
  const lines: string[] = wrap(header, ctx.width).map((l, i) =>
    i === 0 ? l : color("│   ") + l,
  );

  if (item.argsDisplay) {
    const label = item.name === "shell.exec" ? "command" : "input";
    lines.push(bar + chalk.dim(`${label}: `) + chalk.white(item.argsDisplay));
  }

  if (item.status === "blocked" && item.summary) {
    for (const l of wrap(chalk.red(item.summary), ctx.width - 4)) {
      lines.push(bar + l);
    }
  }

  // ── tool.batch: render each sub-tool as its own inline card ─────────────
  if (item.name === "tool.batch" && item.status !== "running" && item.output) {
    const sections = parseBatchSections(item.output);
    if (sections.length > 0) {
      const allOk = sections.every((s) => s.ok);
      const summary = allOk
        ? chalk.dim(`${sections.length} sub-tool(s) — all ok`)
        : chalk.red(
            `${sections.filter((s) => !s.ok).length}/${sections.length} sub-tool(s) failed`,
          );
      lines.push(bar + summary);
      for (const section of sections) {
        const subLines = renderBatchSection(section, () => bar, ctx);
        lines.push(...subLines);
      }
      if (item.artifactPath) {
        lines.push(bar + chalk.dim("saved: ") + chalk.cyan(item.artifactPath));
      }
      lines.push(color("╰"));
      return lines;
    }
    // Fallthrough: if we couldn't parse sections, render normally below.
  }

  const wrappedLines: string[] = [];
  if (item.output) {
    const rawLines = item.output.replace(/\n+$/, "").split("\n");
    for (const raw of rawLines) {
      wrappedLines.push(...wrapAnsiLine(raw, Math.max(10, ctx.width - 4)));
    }
  }

  let shown = wrappedLines;
  let hidden = 0;
  if (!ctx.outputExpanded && item.status !== "running") {
    if (wrappedLines.length > COLLAPSED_OUTPUT_LINES) {
      shown = wrappedLines.slice(0, COLLAPSED_OUTPUT_LINES);
      hidden = wrappedLines.length - shown.length;
    }
  } else if (item.status === "running") {
    // While running, follow the tail so progress is visible.
    shown = wrappedLines.slice(-8);
  }

  if (shown.length > 0) lines.push(bar + chalk.dim("output:"));
  for (const wl of shown) {
    const outputLine = ctx.outputExpanded && item.status !== "running"
      ? chalk.bgHex("#1E293B").hex("#E5E7EB")(`  ${wl} `)
      : "  " + chalk.dim(wl);
    lines.push(bar + outputLine);
  }

  if (item.artifactPath) {
    lines.push(bar + chalk.dim("saved: ") + chalk.cyan(item.artifactPath));
  }

  if (hidden > 0) {
    lines.push(bottom + chalk.dim(`+${hidden} more line(s) · ctrl+o to expand in place`));
  } else if (ctx.outputExpanded && item.output && item.status !== "running") {
    lines.push(bottom + chalk.dim("expanded · ctrl+o/esc to collapse"));
  } else if (item.output || item.status !== "running") {
    lines.push(color("╰"));
  }
  return lines;
}

function renderNotice(level: "info" | "warn", text: string, width: number): string[] {
  const label = level === "warn"
    ? chalk.bgHex("#7F1D1D").hex("#FFFFFF").bold(" ERROR ")
    : chalk.bgHex("#334155").hex("#FFFFFF").bold(" INFO ");
  const color = level === "warn" ? chalk.hex("#FECACA") : chalk.hex("#F8FAFC");
  const rendered: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const available = width - 8;
    const wrapped = /^\s*\S+\s{2,}\S+/.test(line) || /^-+$/.test(line)
      ? [line]
      : wrap(line, available);
    for (const part of wrapped.length ? wrapped : [""]) {
      rendered.push(rendered.length === 0 ? `${label} ${color(part)}` : `       ${color(part)}`);
    }
  }
  return rendered;
}

function renderCompacted(item: CompactedItem, ctx: RenderCtx): string[] {
  const color = chalk.hex("#64748B"); // Slate/dim border
  const bar = color("│ ");
  const top = color("╭ ") + chalk.bold.yellow("✦ Compacted Context");
  const bottom = color("╰ ");

  let summaryText = item.summary || "";
  if (summaryText.startsWith("Session memory from compacted earlier turns:\n\n")) {
    summaryText = summaryText.slice("Session memory from compacted earlier turns:\n\n".length);
  } else if (summaryText.startsWith("Session memory from compacted earlier turns:")) {
    summaryText = summaryText.slice("Session memory from compacted earlier turns:".length);
  }
  
  const rawLines = summaryText.replace(/\n+$/, "").split("\n");
  const wrappedLines: string[] = [];
  for (const raw of rawLines) {
    wrappedLines.push(...wrapAnsiLine(raw, Math.max(10, ctx.width - 4)));
  }

  let shown = wrappedLines;
  let hidden = 0;
  if (!ctx.outputExpanded) {
    if (wrappedLines.length > 3) {
      shown = wrappedLines.slice(0, 3);
      hidden = wrappedLines.length - shown.length;
    }
  }

  const lines: string[] = [top];
  for (const wl of shown) {
    lines.push(bar + chalk.dim(wl));
  }

  if (hidden > 0) {
    lines.push(bottom + chalk.dim(`+${hidden} more line(s) · ctrl+o to expand in place`));
  } else {
    lines.push(bottom + chalk.dim("expanded · ctrl+o/esc to collapse"));
  }

  return lines;
}

export function renderItemLines(item: TranscriptItem, ctx: RenderCtx): string[] {
  switch (item.kind) {
    case "user":
      return renderUser(item.text, ctx.width);
    case "assistant":
      return renderAssistant(item.text, ctx.width);
    case "thinking":
      return renderThinking(item.content, ctx);
    case "tool":
      return renderTool(item, ctx);
    case "notice":
      return renderNotice(item.level, item.text, ctx.width);
    case "plan":
      return renderPlanChecklist(item.plan).split("\n");
    case "compacted":
      return renderCompacted(item as CompactedItem, ctx);
  }
}

function renderHeader(ctx: RenderCtx): string[] {
  const version = ctx.version ?? "0.0.0";
  const mode = ctx.mode ?? "agent";
  const provider = ctx.provider ?? "openai";
  const model = ctx.model ?? "gpt-4";

  const width = Math.max(40, ctx.width - 4);
  const innerWidth = width - 4;
  
  // Left part: " ◆ clai  v{version}"
  const leftPlain = ` ◆ clai  v${version}`;
  const leftColored = chalk.bgBlue.white.bold(" ◆ clai ") + chalk.gray(` v${version}`);
  
  // Right part: " {mode}  MODE"
  const rightPlain = ` ${mode.toUpperCase()}  MODE`;
  const rightColored = chalk.bgYellow.black.bold(` ${mode.toUpperCase()} `) + chalk.gray(" MODE");
  
  // Line 1: space between
  const spaceCount = Math.max(1, innerWidth - leftPlain.length - rightPlain.length);
  const line1 = " " + leftColored + " ".repeat(spaceCount) + rightColored + " ";
  
  // Line 2: "{provider} / {model} · {cwd}"
  const cwd = safeCwd();
  const providerPart = chalk.green(provider);
  const modelPart = chalk.cyan(model);
  const cwdPart = chalk.gray(` ·  ${cwd}`);
  const line2Inner = `${provider} / ${model} ·  ${cwd}`;
  const line2ColoredInner = providerPart + chalk.gray(" / ") + modelPart + cwdPart;
  
  // Truncate line 2 if it's too long
  let line2PlainInner = line2Inner;
  let finalLine2Inner = line2ColoredInner;
  if (line2Inner.length > innerWidth) {
    const spaceForCwd = Math.max(5, innerWidth - provider.length - model.length - 12);
    const truncatedCwd = cwd.slice(0, spaceForCwd) + "…";
    line2PlainInner = `${provider} / ${model} ·  ${truncatedCwd}`;
    finalLine2Inner = providerPart + chalk.gray(" / ") + modelPart + chalk.gray(" ·  ") + chalk.gray(truncatedCwd);
  }
  const line2Pad = Math.max(0, innerWidth - line2PlainInner.length);
  const line2Content = " " + finalLine2Inner + " ".repeat(line2Pad) + " ";

  const topStr = "  " + chalk.gray("╭" + "─".repeat(innerWidth + 2) + "╮");
  const botStr = "  " + chalk.gray("╰" + "─".repeat(innerWidth + 2) + "╯");
  
  return [
    "", // Blank line to prevent the header from getting cut off at the terminal top edge
    topStr,
    "  " + chalk.gray("│") + line1 + chalk.gray("│"),
    "  " + chalk.gray("│") + line2Content + chalk.gray("│"),
    botStr
  ];
}

/**
 * Flatten the whole transcript (plus any transient streaming text) into a
 * single array of ANSI lines, separated by blank lines, ready for the
 * scrolling viewport. Rendering to lines (rather than Ink boxes) lets toggles
 * like Ctrl+T / Ctrl+O recompute in place and lets us pin the composer.
 */
export function renderTranscriptLines(state: TuiState, ctx: RenderCtx): string[] {
  const blocks: string[][] = [];
  blocks.push(renderHeader(ctx));

  for (const item of state.items) {
    blocks.push(renderItemLines(item, ctx));
  }

  // While generating: show the live thinking preview (before any response
  // streams). Once the step finishes it commits as a collapsed thinking hint.
  if (state.status.running && state.thinkingPreview && !state.streaming) {
    const body = wrap(state.thinkingPreview, ctx.width - 4).map((l) =>
      chalk.dim("  " + l),
    );
    blocks.push([chalk.dim.italic("✦ thinking…"), ...body]);
  }

  // Transient streaming text for the active step (suppressed when it is a
  // tool-call fence, which will be replaced by a clean tool card).
  if (state.streaming) {
    const visibleStreaming = stripStreamingToolFence(state.streaming);
    if (visibleStreaming.trim().length > 0) {
      const md = renderMarkdown(visibleStreaming).replace(/\n+$/, "");
      blocks.push([
        chalk.magenta.bold("◆ Response"),
        ...md.split("\n").map((line) => `  ${line}`),
        chalk.magenta("  ▌"),
      ]);
    }
  }

  const lines: string[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) lines.push("");
    lines.push(...block);
  });
  return lines;
}
