import chalk from "chalk";
import type { TranscriptItem, ToolItem, TuiState } from "./state.js";
import { renderMarkdown, wrapAnsiLine } from "../ui/markdown.js";
import { renderPlanChecklist } from "../ui/plan-pane.js";

export interface RenderCtx {
  width: number;
  thinkingExpanded: boolean;
  outputExpanded: boolean;
  running: boolean;
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
  const tag = chalk.bgMagenta.whiteBright.bold(" you ");
  const body = chalk.bold(text);
  const lines = wrap(body, width - 8);
  return lines.map((l, i) =>
    i === 0 ? `${tag} ${l}` : `      ${l}`,
  );
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
      lines.push(bar + "  " + chalk.dim(wl));
    }
  }

  if (item.artifactPath) {
    lines.push(bar + chalk.dim("saved: ") + chalk.cyan(item.artifactPath));
  }

  if (hidden > 0) {
    lines.push(bottom + chalk.dim(`+${hidden} more line(s) · ctrl+o to expand`));
  } else if (item.output || item.status !== "running") {
    lines.push(color("╰"));
  }
  return lines;
}

function renderNotice(level: "info" | "warn", text: string, width: number): string[] {
  const glyph = level === "warn" ? chalk.yellow("⚠") : chalk.dim("ℹ");
  const color = level === "warn" ? chalk.yellow : chalk.dim;
  return wrap(text, width - 2).map((l, i) => (i === 0 ? `${glyph} ${color(l)}` : `  ${color(l)}`));
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
  }
}

/**
 * Flatten the whole transcript (plus any transient streaming text) into a
 * single array of ANSI lines, separated by blank lines, ready for the
 * scrolling viewport. Rendering to lines (rather than Ink boxes) lets toggles
 * like Ctrl+T / Ctrl+O recompute in place and lets us pin the composer.
 */
export function renderTranscriptLines(state: TuiState, ctx: RenderCtx): string[] {
  const blocks: string[][] = [];
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
