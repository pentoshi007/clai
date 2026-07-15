/**
 * Shared TUI intro / model card: two-partition box with CLAI wordmark +
 * session info (workdir/model/provider/version + mode/permission badges),
 * plus centered tagline and welcome line.
 *
 * Used by the legacy Ink TUI and OpenTUI v2 so both show the same card.
 * Width is a hard budget: when the chat pane shrinks (plan split / overlay),
 * the card reflows so borders never overflow or "break".
 */

import chalk from "chalk";
import { renderWordmark, wordmarkWidth, WORDMARK_TOP_HEX } from "./wordmark.js";

/** Card frame — same magenta as the top of the CLAI wordmark "I". */
const cardBorder = chalk.hex(WORDMARK_TOP_HEX);

/** Truncate long text in the middle (avoids importing from tui/). */
function truncateMiddle(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  const keep = maxWidth - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = Math.floor(keep * 0.4);
  return `${text.slice(0, head)}…${text.slice(Math.max(0, text.length - tail))}`;
}

export interface IntroHeaderOptions {
  width: number;
  version: string;
  mode: string;
  provider: string;
  model: string;
  permissions: string;
  workdir: string;
}

function stripAnsiLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padCell(content: string, width: number): string {
  const len = stripAnsiLen(content);
  if (len > width) {
    // Hard-clip ANSI-aware by stripping for length then re-padding plain.
    const plain = content.replace(/\x1b\[[0-9;]*m/g, "");
    return truncateMiddle(plain, width);
  }
  if (len === width) return content;
  return content + " ".repeat(width - len);
}

function centerCell(content: string, width: number): string {
  const len = stripAnsiLen(content);
  if (len > width) {
    const plain = content.replace(/\x1b\[[0-9;]*m/g, "");
    return truncateMiddle(plain, width);
  }
  if (len === width) return content;
  const total = width - len;
  const left = Math.floor(total / 2);
  return " ".repeat(left) + content + " ".repeat(total - left);
}

/**
 * Full startup intro card as ANSI lines. Always the first transcript block;
 * it scrolls up naturally with the conversation.
 */
export function renderIntroHeaderLines(opts: IntroHeaderOptions): string[] {
  // Always emit truecolor SGR so OpenTUI (and non-TTY tests) get the same
  // colored layout as a real interactive terminal.
  const prevLevel = chalk.level;
  if (chalk.level < 3) chalk.level = 3;

  try {
    return renderIntroHeaderLinesInner(opts);
  } finally {
    chalk.level = prevLevel;
  }
}

function renderIntroHeaderLinesInner(opts: IntroHeaderOptions): string[] {
  const version = opts.version || "0.0.0";
  const mode = opts.mode || "agent";
  const provider = opts.provider || "openai";
  const model = opts.model || "gpt-4";
  const permissions = opts.permissions || "default";
  const cwd = opts.workdir;

  // Hard budget: never wider than the pane we were given (plan pane must not
  // clip mid-border). Prefer a small outer margin when the pane allows it.
  const pane = Math.max(24, opts.width);
  // Card outer plain width target (including the leading two spaces on each row).
  const totalWidth = Math.max(20, pane);

  // Row shape: "  " + "│ " + left + " │ " + right + " │"
  // Leading indent (2) + borders/padding (7) = 9 fixed columns.
  const LEAD = 2;
  const OVERHEAD = 7;
  const wmLines = renderWordmark("CLAI", "").split("\n");
  const wmWidth = wordmarkWidth("CLAI");

  const available = Math.max(12, totalWidth - LEAD - OVERHEAD);

  // Side-by-side needs room for the wordmark + a usable info column.
  // Below that threshold, fall back to a stacked compact card so borders stay
  // intact when Ctrl+H opens the plan pane.
  const minSideBySide = wmWidth + 2 + 18;
  if (available < minSideBySide) {
    return renderCompactCard({
      totalWidth,
      version,
      mode,
      provider,
      model,
      permissions,
      cwd,
      wmLines,
    });
  }

  // Fit left/right exactly into `available` — never let mins overflow the pane.
  let leftWidth = Math.max(wmWidth + 2, Math.floor(available * 0.38));
  let rightWidth = available - leftWidth;
  if (rightWidth < 16) {
    rightWidth = 16;
    leftWidth = available - rightWidth;
  }
  if (leftWidth < wmWidth) {
    leftWidth = Math.min(wmWidth, available - 12);
    rightWidth = available - leftWidth;
  }

  const CHIP_LABEL = Math.min(8, Math.max(4, rightWidth - 10));
  const chip = (label: string): string =>
    chalk.bgHex("#334155").whiteBright.bold(` ${label.padEnd(CHIP_LABEL).slice(0, CHIP_LABEL)} `);
  const CHIP_WIDTH = CHIP_LABEL + 2;

  const infoRow = (label: string, value: string, colorFn: (s: string) => string): string => {
    const room = Math.max(2, rightWidth - CHIP_WIDTH - 1);
    const shownValue = value.length > room ? truncateMiddle(value, room) : value;
    return chip(label) + " " + colorFn(shownValue);
  };

  const modeBanner = chalk.bgHex("#B45309").whiteBright.bold(
    `  ${mode.toUpperCase()} MODE  `,
  );

  const permBgColor = permissions === "allow-all" ? "#15803d" : "#334155";
  const permissionsBanner = chalk.bgHex(permBgColor).whiteBright.bold(
    `  ${permissions.toUpperCase()}  `,
  );
  const permLabel = chalk.bgHex("#334155").whiteBright.bold(` PERMISSION `);

  const rightRows: string[] = [
    "",
    infoRow("workdir", cwd, chalk.white),
    infoRow("model", model, chalk.cyan),
    infoRow("provider", provider, chalk.green),
    infoRow("version", version, chalk.white),
    "",
    modeBanner,
    "",
    `${permLabel} ${permissionsBanner}`,
    "",
  ];
  const rowCount = Math.max(wmLines.length, rightRows.length);

  // Border segments: "╭" + "─"*(left+2) + "┬" + "─"*(right+2) + "╮"
  // plain length = left + right + 7, plus LEAD indent = totalWidth budget.
  const top =
    "  " +
    cardBorder(
      `╭${"─".repeat(leftWidth + 2)}┬${"─".repeat(rightWidth + 2)}╮`,
    );
  const bottom =
    "  " +
    cardBorder(
      `╰${"─".repeat(leftWidth + 2)}┴${"─".repeat(rightWidth + 2)}╯`,
    );

  const middle: string[] = [];
  const wmPadTop = Math.floor((rowCount - wmLines.length) / 2);
  const wmPadBot = rowCount - wmLines.length - wmPadTop;
  const paddedWm = [
    ...Array<string>(wmPadTop).fill(""),
    ...wmLines,
    ...Array<string>(wmPadBot).fill(""),
  ];
  for (let i = 0; i < rowCount; i++) {
    const leftCell = centerCell(paddedWm[i] ?? "", leftWidth);
    const rightCell = padCell(rightRows[i] ?? "", rightWidth);
    middle.push(
      "  " +
        cardBorder("│") +
        ` ${leftCell} ` +
        cardBorder("│") +
        ` ${rightCell} ` +
        cardBorder("│"),
    );
  }

  const boxOuterWidth = LEAD + leftWidth + rightWidth + OVERHEAD;

  const centerIndent = (plainLen: number): string => {
    const indent = Math.max(0, Math.floor((boxOuterWidth - plainLen) / 2));
    return " ".repeat(indent);
  };

  const taglineBudget = Math.max(12, boxOuterWidth);
  const tagline =
    available >= 60
      ? "AI-powered terminal assistant · ask & agent modes for shell, files & security workflows"
      : "AI terminal assistant · ask & agent modes";
  const welcome = `Welcome to clai v${version}! `;
  const welcomeHint =
    available >= 52
      ? "/history past chats · /help commands"
      : "/history · /help";
  const welcomeFull = welcome + welcomeHint;

  return [
    "",
    top,
    ...middle,
    bottom,
    "",
    centerIndent(Math.min(tagline.length, taglineBudget)) +
      chalk.white(truncateMiddle(tagline, taglineBudget)),
    centerIndent(Math.min(welcomeFull.length, taglineBudget)) +
      chalk.green.bold(truncateMiddle(welcome, Math.max(8, taglineBudget - welcomeHint.length))) +
      chalk.cyan(welcomeHint.length + welcome.length <= taglineBudget ? welcomeHint : ""),
  ];
}

/** Narrow-pane card: wordmark on top, info stacked below — borders always fit. */
function renderCompactCard(args: {
  totalWidth: number;
  version: string;
  mode: string;
  provider: string;
  model: string;
  permissions: string;
  cwd: string;
  wmLines: string[];
}): string[] {
  const { totalWidth, version, mode, provider, model, permissions, cwd, wmLines } = args;
  // Outer line budget includes the two-space indent + border glyphs.
  // top = "  " + "╭" + "─"*N + "╮"  → plain length 4 + N, so N = totalWidth - 4.
  const rule = Math.max(8, totalWidth - 4);
  const inner = Math.max(6, rule - 2); // content between "│ " and " │"
  const top = "  " + cardBorder(`╭${"─".repeat(rule)}╮`);
  const bottom = "  " + cardBorder(`╰${"─".repeat(rule)}╯`);
  const row = (content: string): string =>
    "  " + cardBorder("│") + ` ${padCell(content, inner)} ` + cardBorder("│");

  const chip = (label: string, value: string, colorFn: (s: string) => string): string => {
    const shortLabel = label.slice(0, Math.min(label.length, 4));
    const labelPart = chalk.bgHex("#334155").whiteBright.bold(` ${shortLabel} `);
    const room = Math.max(2, inner - stripAnsiLen(` ${shortLabel} `) - 1);
    return labelPart + " " + colorFn(truncateMiddle(value, room));
  };

  const modeBanner = chalk.bgHex("#B45309").whiteBright.bold(
    truncateMiddle(` ${mode.toUpperCase()} MODE `, inner),
  );
  const permBg = permissions === "allow-all" ? "#15803d" : "#334155";
  const permBanner = chalk.bgHex(permBg).whiteBright.bold(
    truncateMiddle(` ${permissions.toUpperCase()} `, inner),
  );

  const welcomePlain = `Welcome to clai v${version}! /history · /help`;
  const welcome =
    "  " +
    chalk.green.bold(truncateMiddle(`Welcome to clai v${version}! `, Math.max(8, totalWidth - 16))) +
    chalk.cyan(totalWidth >= 40 ? "/history · /help" : totalWidth >= 28 ? "/history" : "");

  const lines: string[] = ["", top];
  for (const wm of wmLines) {
    lines.push(row(centerCell(wm, inner)));
  }
  lines.push(row(""));
  lines.push(row(chip("workdir", cwd, chalk.white)));
  lines.push(row(chip("model", model, chalk.cyan)));
  lines.push(row(chip("provider", provider, chalk.green)));
  lines.push(row(chip("version", version, chalk.white)));
  lines.push(row(""));
  lines.push(row(modeBanner));
  lines.push(row(permBanner));
  lines.push(bottom);
  lines.push("");
  lines.push(welcome.length > 0 ? welcome : "  " + chalk.green(truncateMiddle(welcomePlain, totalWidth)));
  return lines;
}
