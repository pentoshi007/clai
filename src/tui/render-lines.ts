import chalk from "chalk";
import type { TranscriptItem, ToolItem, TuiState, CompactedItem } from "./state.js";
import { renderMarkdown, wrapAnsiLine } from "../ui/markdown.js";
import { renderPlanChecklist } from "../ui/plan-pane.js";
import { safeCwd } from "../os/cwd.js";
import { renderWordmark, wordmarkWidth } from "../ui/wordmark.js";
import { truncateMiddle } from "./text-format.js";

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
    const HEAD = 3;
    const TAIL = 3;
    let shown: string[];
    let hiddenCount = 0;
    if (ctx.outputExpanded) {
      shown = wrappedLines;
    } else if (wrappedLines.length <= HEAD + TAIL) {
      shown = wrappedLines;
    } else {
      const head = wrappedLines.slice(0, HEAD);
      const tail = wrappedLines.slice(-TAIL);
      hiddenCount = wrappedLines.length - HEAD - TAIL;
      shown = [...head, chalk.dim(`    ··· ${hiddenCount} more lines ···`), ...tail];
    }
    for (const wl of shown) {
      lines.push(subBar + chalk.white(wl));
    }
    if (hiddenCount > 0) {
      lines.push(
        subBottom +
          chalk.dim.white(`+${hiddenCount + HEAD + TAIL} total line(s) · `) +
          chalk.bold.white("ctrl+o") +
          chalk.white(" to expand"),
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
  const md = renderMarkdown(text, width - 8).replace(/\n+$/, "");
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
  const md = renderMarkdown(text, width - 2).replace(/\n+$/, "");
  return [label, "", ...md.split("\n").map((line) => `  ${line}`)];
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
    const prefix = chalk.dim(`${label}: `);
    const prefixLen = `${label}: `.length;
    const wrappedArgs = wrap(item.argsDisplay, ctx.width - 4 - prefixLen);
    wrappedArgs.forEach((l, idx) => {
      if (idx === 0) {
        lines.push(bar + prefix + chalk.white(l));
      } else {
        lines.push(bar + " ".repeat(prefixLen) + chalk.white(l));
      }
    });
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

  const COLLAPSED_HEAD = 3;
  const COLLAPSED_TAIL = 3;
  let shown = wrappedLines;
  let hiddenCount = 0;
  if (ctx.outputExpanded && item.status !== "running") {
    // Fully expanded — show everything
    shown = wrappedLines;
  } else if (item.status === "running") {
    // While running: show first 3 + gap + last 3 (tail updates live)
    if (wrappedLines.length <= COLLAPSED_HEAD + COLLAPSED_TAIL) {
      shown = wrappedLines;
    } else {
      const head = wrappedLines.slice(0, COLLAPSED_HEAD);
      const tail = wrappedLines.slice(-COLLAPSED_TAIL);
      hiddenCount = wrappedLines.length - COLLAPSED_HEAD - COLLAPSED_TAIL;
      shown = [...head, chalk.dim(`    ··· ${hiddenCount} more lines ···`), ...tail];
    }
  } else {
    // Collapsed finished tool
    if (wrappedLines.length <= COLLAPSED_HEAD + COLLAPSED_TAIL) {
      shown = wrappedLines;
    } else {
      const head = wrappedLines.slice(0, COLLAPSED_HEAD);
      const tail = wrappedLines.slice(-COLLAPSED_TAIL);
      hiddenCount = wrappedLines.length - COLLAPSED_HEAD - COLLAPSED_TAIL;
      shown = [...head, chalk.dim(`    ··· ${hiddenCount} more lines ···`), ...tail];
    }
  }

  if (shown.length > 0) lines.push(bar + chalk.dim("output:"));
  for (const wl of shown) {
    const outputLine = ctx.outputExpanded && item.status !== "running"
      ? chalk.bgHex("#1E293B").hex("#E5E7EB")(`  ${wl} `)
      : "  " + chalk.white(wl);
    lines.push(bar + outputLine);
  }

  if (item.artifactPath) {
    lines.push(bar + chalk.dim("saved: ") + chalk.cyan(item.artifactPath));
  }

  if (hiddenCount > 0 && item.status !== "running") {
    lines.push(
      bottom +
        chalk.dim.white(`+${hiddenCount} more line(s) · `) +
        chalk.bold.white("ctrl+o") +
        chalk.white(" to expand in place"),
    );
  } else if (ctx.outputExpanded && item.output && item.status !== "running") {
    lines.push(
      bottom +
        chalk.dim.white("expanded · ") +
        chalk.bold.white("ctrl+o/esc") +
        chalk.white(" to collapse"),
    );
  } else if (item.output || item.status !== "running") {
    lines.push(color("╰"));
  }
  return lines;
}

function renderNotice(level: "info" | "warn", text: string, width: number): string[] {
  const label = level === "warn"
    ? chalk.bgHex("#D97706").hex("#FFFFFF").bold(" WARN ")
    : chalk.bgHex("#334155").hex("#FFFFFF").bold(" INFO ");
  const color = level === "warn" ? chalk.hex("#FEF3C7") : chalk.hex("#F8FAFC");
  const rendered: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const available = width - 8;
    const wrapped = wrap(line, available);
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

  const HEAD = 3;
  const TAIL = 3;
  let shown = wrappedLines;
  let hiddenCount = 0;
  if (!ctx.outputExpanded) {
    if (wrappedLines.length > HEAD + TAIL) {
      const head = wrappedLines.slice(0, HEAD);
      const tail = wrappedLines.slice(-TAIL);
      hiddenCount = wrappedLines.length - HEAD - TAIL;
      shown = [...head, chalk.dim(`    ··· ${hiddenCount} more lines ···`), ...tail];
    }
  }

  const lines: string[] = [top];
  for (const wl of shown) {
    lines.push(bar + chalk.dim(wl));
  }

  if (hiddenCount > 0) {
    lines.push(
      bottom +
        chalk.dim.white(`+${hiddenCount} more line(s) · `) +
        chalk.bold.white("ctrl+o") +
        chalk.white(" to expand in place"),
    );
  } else if (ctx.outputExpanded) {
    lines.push(
      bottom +
        chalk.dim.white("expanded · ") +
        chalk.bold.white("ctrl+o/esc") +
        chalk.white(" to collapse"),
    );
  } else {
    lines.push(bottom);
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

/**
 * Per-item render cache. Rendering a transcript item (markdown parse + ANSI
 * styling + wrapping) is the dominant cost when streaming, because the whole
 * transcript is re-flattened on every render. Committed items never change,
 * so we cache their rendered lines keyed by the item's object identity (the
 * reducer keeps the same reference for unchanged items) plus a signature of
 * the render context that actually affects output. Only finished, non-running
 * items are cached — streaming/running items are cheap to recompute and change
 * every tick anyway.
 */
const itemLineCache = new WeakMap<TranscriptItem, { sig: string; lines: string[] }>();

function ctxSignature(ctx: RenderCtx): string {
  return `${ctx.width}|${ctx.thinkingExpanded ? 1 : 0}|${ctx.outputExpanded ? 1 : 0}`;
}

function renderItemLinesCached(item: TranscriptItem, ctx: RenderCtx): string[] {
  const isRunningTool = item.kind === "tool" && item.status === "running";
  if (!item.done || isRunningTool) {
    return renderItemLines(item, ctx);
  }
  const sig = ctxSignature(ctx);
  const cached = itemLineCache.get(item);
  if (cached && cached.sig === sig) return cached.lines;
  const lines = renderItemLines(item, ctx);
  itemLineCache.set(item, { sig, lines });
  return lines;
}

/** Compact one-box header shown once a conversation is under way. */
function renderCompactHeader(ctx: RenderCtx): string[] {
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

function stripAnsiLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/** Pad a (possibly ANSI-colored) cell string to a visible width. */
function padCell(content: string, width: number): string {
  const len = stripAnsiLen(content);
  if (len >= width) return content;
  return content + " ".repeat(width - len);
}

/** Center a (possibly ANSI-colored) cell string within a visible width. */
function centerCell(content: string, width: number): string {
  const len = stripAnsiLen(content);
  if (len >= width) return content;
  const total = width - len;
  const left = Math.floor(total / 2);
  return " ".repeat(left) + content + " ".repeat(total - left);
}

/**
 * Full startup intro card: one big two-partition box — a gradient "CLAI"
 * wordmark on the left, and a session-info panel (workdir/model/provider/
 * mode/version + quick-start hints) on the right — with the tagline and
 * welcome line centered below it. Only shown while the transcript is empty;
 * once the conversation starts, the compact header takes over so the
 * wordmark doesn't eat scroll space.
 *
 * The wordmark's own width is fixed (it's dot-matrix ASCII art), but the
 * right partition — and therefore the whole card — stretches or shrinks
 * with the terminal width, so the card scales without ever breaking its
 * box-drawing alignment.
 */
function renderIntroHeader(ctx: RenderCtx): string[] {
  const version = ctx.version ?? "0.0.0";
  const mode = ctx.mode ?? "agent";
  const provider = ctx.provider ?? "openai";
  const model = ctx.model ?? "gpt-4";
  const cwd = safeCwd();

  // Overall available width for the card (2-space left/right margin).
  const totalWidth = Math.max(56, ctx.width - 4);

  // Left partition: the wordmark (fixed-width ASCII art). We give the left
  // column a bit more room than the wordmark itself so the logo has some
  // breathing space and isn't sandwiched against the box borders, and we
  // aim for the two partitions to be roughly equal width.
  //
  // Fixed overhead per row: "│ " + leftCell + " │ " + rightCell + " │"
  //   = 2 borders + 1 separator + 4 padding spaces = 7 columns.
  const OVERHEAD = 7;
  const wmLines = renderWordmark("CLAI", "").split("\n");
  const wmWidth = wordmarkWidth("CLAI");

  const available = Math.max(48, totalWidth - OVERHEAD); // combined cell width
  const halfWidth = Math.floor(available / 2);
  const leftWidth = Math.max(wmWidth + 6, halfWidth); // +6 → breathing room
  const rightWidth = Math.max(24, available - leftWidth);

  // High-contrast label chip (solid background + bright bold text), matching
  // the visual language used by the compact header's badges. The longest
  // label ("provider") is padded so every chip has the same visible width.
  const CHIP_LABEL = 8;
  const chip = (label: string): string =>
    chalk.bgHex("#334155").whiteBright.bold(` ${label.padEnd(CHIP_LABEL)} `);
  const CHIP_WIDTH = CHIP_LABEL + 2; // padding inside the chip

  const infoRow = (label: string, value: string, colorFn: (s: string) => string): string => {
    const available = Math.max(4, rightWidth - CHIP_WIDTH - 1);
    const shownValue = value.length > available ? truncateMiddle(value, available) : value;
    return chip(label) + " " + colorFn(shownValue);
  };

  const suggestions = [
    "scan my network",
    "recon example.com",
    "create a react app here",
    "explain @file.ts",
  ];
  const tryChip = chalk.bgHex("#334155").whiteBright.bold(" try ");
  const TRY_WIDTH = 5; // visible width of " try "
  const suggestionsAvailable = Math.max(4, rightWidth - TRY_WIDTH - 1);
  const suggestionsJoined = suggestions.join(" │ ");
  const suggestionsShown =
    suggestionsJoined.length > suggestionsAvailable
      ? truncateMiddle(suggestionsJoined, suggestionsAvailable)
      : suggestionsJoined;

  const rightRows: string[] = [
    infoRow("workdir", cwd, chalk.white),
    infoRow("model", model, chalk.cyan),
    infoRow("provider", provider, chalk.green),
    infoRow("mode", mode, chalk.yellow),
    infoRow("version", version, chalk.white),
    "",
    tryChip + " " + chalk.cyan.italic(suggestionsShown),
  ];

  // Both columns render exactly 7 rows (wordmark height), so they line up.
  const rowCount = Math.max(wmLines.length, rightRows.length);

  const top =
    "  " +
    chalk.gray(
      `╭${"─".repeat(leftWidth + 2)}┬${"─".repeat(rightWidth + 2)}╮`,
    );
  const bottom =
    "  " +
    chalk.gray(
      `╰${"─".repeat(leftWidth + 2)}┴${"─".repeat(rightWidth + 2)}╯`,
    );

  const middle: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const leftCell = centerCell(wmLines[i] ?? "", leftWidth);
    const rightCell = padCell(rightRows[i] ?? "", rightWidth);
    middle.push(
      "  " +
        chalk.gray("│") +
        ` ${leftCell} ` +
        chalk.gray("│") +
        ` ${rightCell} ` +
        chalk.gray("│"),
    );
  }

  const boxOuterWidth = leftWidth + rightWidth + OVERHEAD;

  const centerIndent = (plainLen: number): string => {
    const indent = Math.max(0, Math.floor((boxOuterWidth - plainLen) / 2));
    return " ".repeat(2 + indent);
  };

  const tagline =
    "AI-powered terminal assistant · ask & agent modes for shell, files & security workflows";
  const welcome = `Welcome to clai v${version}! `;
  const welcomeHint = "/help for commands.";

  return [
    "",
    top,
    ...middle,
    bottom,
    "",
    centerIndent(tagline.length) + chalk.dim(tagline),
    centerIndent(welcome.length + welcomeHint.length) +
      chalk.green.bold(welcome) +
      chalk.dim(welcomeHint),
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
  blocks.push(
    state.items.length === 0 ? renderIntroHeader(ctx) : renderCompactHeader(ctx),
  );

  for (const item of state.items) {
    blocks.push(renderItemLinesCached(item, ctx));
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
      const md = renderMarkdown(visibleStreaming, ctx.width - 2).replace(/\n+$/, "");
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
