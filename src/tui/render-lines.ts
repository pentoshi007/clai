import chalk from "chalk";
import type { TranscriptItem, ToolItem, TuiState, CompactedItem } from "./state.js";
import { renderMarkdown, wrapAnsiLine } from "../ui/markdown.js";
import { renderPlanChecklist } from "../ui/plan-pane.js";
import { safeCwd } from "../os/cwd.js";

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

function looksLikeToolFence(text: string): boolean {
  const t = text.trimStart();
  return (
    /^```\s*(tool|json)?/i.test(t) ||
    /^\{[\s\S]*"name"\s*:/.test(t) ||
    /^<tool/i.test(t)
  );
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
    const whiteLine = "\x1b[37m" + l.replace(/\x1b\[39m/g, "\x1b[37m") + "\x1b[39m";
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

  const rawLines = item.output ? item.output.replace(/\n+$/, "").split("\n") : [];
  let shown = rawLines;
  let hidden = 0;
  if (!ctx.outputExpanded && item.status !== "running") {
    if (rawLines.length > COLLAPSED_OUTPUT_LINES) {
      shown = rawLines.slice(0, COLLAPSED_OUTPUT_LINES);
      hidden = rawLines.length - shown.length;
    }
  } else if (item.status === "running") {
    // While running, follow the tail so progress is visible.
    shown = rawLines.slice(-8);
  }

  if (shown.length > 0) lines.push(bar + chalk.dim("output:"));
  for (const raw of shown) {
    for (const wl of wrapAnsiLine(raw, Math.max(10, ctx.width - 2))) {
      const outputLine = ctx.outputExpanded && item.status !== "running"
        ? chalk.bgHex("#1E293B").hex("#E5E7EB")(`  ${wl} `)
        : "  " + chalk.dim(wl);
      lines.push(bar + outputLine);
    }
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

  const rawLines = item.summary ? item.summary.replace(/\n+$/, "").split("\n") : [];
  let shown = rawLines;
  let hidden = 0;
  if (!ctx.outputExpanded) {
    if (rawLines.length > 3) {
      shown = rawLines.slice(0, 3);
      hidden = rawLines.length - shown.length;
    }
  }

  const lines: string[] = [top];
  for (const raw of shown) {
    for (const wl of wrapAnsiLine(raw, Math.max(10, ctx.width - 4))) {
      lines.push(bar + chalk.dim(wl));
    }
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
  if (state.streaming && !looksLikeToolFence(state.streaming)) {
    const md = renderMarkdown(state.streaming).replace(/\n+$/, "");
    blocks.push([chalk.magenta.bold("◆ Response"), ...md.split("\n").map((line) => `  ${line}`), chalk.magenta("  ▌")]);
  }

  const lines: string[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) lines.push("");
    lines.push(...block);
  });
  return lines;
}
