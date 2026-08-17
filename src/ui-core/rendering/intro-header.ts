import chalk from "chalk";
import { renderWordmark, wordmarkWidth } from "./wordmark.js";

const CARD_BORDER_HEX = "#2EEBFF";
const cardBorder = chalk.hex(CARD_BORDER_HEX);

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
  variant?: string | undefined;
}

function stripAnsiLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function padCell(content: string, width: number): string {
  const len = stripAnsiLen(content);
  if (len > width) {
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

function displayPermissions(permissions: string): string {
  return permissions === "allow-all" ? "auto-allow" : permissions;
}

function displayModel(model: string, variant?: string): string {
  if (!variant || variant === "off") return model;
  return `${model}(${variant})`;
}

export function renderIntroHeaderLines(opts: IntroHeaderOptions): string[] {
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
  const model = displayModel(opts.model || "gpt-4", opts.variant);
  const permissions = displayPermissions(opts.permissions || "default");
  const rawPermissions = opts.permissions || "default";
  const variant = opts.variant;
  const cwd = opts.workdir;

  const pane = Math.max(24, opts.width);
  const totalWidth = Math.max(20, pane);

  const LEAD = 2;
  const OVERHEAD = 7;
  const wmLines = renderWordmark("CLAI", "").split("\n");
  const wmWidth = wordmarkWidth("CLAI");

  const available = Math.max(12, totalWidth - LEAD - OVERHEAD);

  const minSideBySide = Math.max(wmWidth * 2, 36);
  if (available < minSideBySide) {
    return renderCompactCard({
      totalWidth,
      version,
      mode,
      provider,
      model,
      permissions,
      rawPermissions,
      variant,
      cwd,
      wmLines,
    });
  }

  const leftWidth = Math.floor(available / 2);
  const rightWidth = available - leftWidth;

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

  const permBgColor = rawPermissions === "allow-all" ? "#15803d" : "#334155";
  const permissionsBanner = chalk.bgHex(permBgColor).whiteBright.bold(
    `  ${permissions.toUpperCase()}  `,
  );
  const permLabel = chalk.bgHex("#334155").whiteBright.bold(` PERMISSION `);

  const rightRows: string[] = [
    "",
    infoRow("workdir", cwd, chalk.white),
    infoRow("model", model, chalk.cyan),
    infoRow("provider", provider, chalk.green),
    ...(variant ? [infoRow("effort", variant, chalk.magenta)] : []),
    infoRow("version", version, chalk.white),
    "",
    modeBanner,
    "",
    `${permLabel} ${permissionsBanner}`,
    "",
  ];
  const rowCount = Math.max(wmLines.length, rightRows.length);

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

function renderCompactCard(args: {
  totalWidth: number;
  version: string;
  mode: string;
  provider: string;
  model: string;
  permissions: string;
  rawPermissions: string;
  variant?: string | undefined;
  cwd: string;
  wmLines: string[];
}): string[] {
  const { totalWidth, version, mode, provider, model, permissions, rawPermissions, variant, cwd, wmLines } = args;
  const rule = Math.max(8, totalWidth - 4);
  const inner = Math.max(6, rule - 2);
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
  const permBg = rawPermissions === "allow-all" ? "#15803d" : "#334155";
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
  if (variant) lines.push(row(chip("effort", variant, chalk.magenta)));
  lines.push(row(chip("version", version, chalk.white)));
  lines.push(row(""));
  lines.push(row(modeBanner));
  lines.push(row(permBanner));
  lines.push(bottom);
  lines.push("");
  lines.push(welcome.length > 0 ? welcome : "  " + chalk.green(truncateMiddle(welcomePlain, totalWidth)));
  return lines;
}
