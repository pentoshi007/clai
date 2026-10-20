import chalk from "chalk";
import { homedir } from "node:os";
import { sep } from "node:path";
import { normalizeProvider } from "../../llm/provider.js";
import { getProvider } from "../../llm/router.js";
import { renderWordmark, wordmarkWidth } from "./wordmark.js";
import { DEFAULT_PERMISSION_MODE, permissionModeLabel } from "../../safety/permission-mode.js";
import { CARD_BORDER_HEX, CARD_INSET_COLUMNS } from "./card-style.js";
import { middleClipText, terminalWidth } from "./text-width.js";
import { themeFor, type Theme } from "./theme.js";

const cardBorder = chalk.hex(CARD_BORDER_HEX);

const SGR = /\x1b\[[0-9;]*m/g;

const CHIP_BG = "#334155";

const PERMISSION_BG: Record<string, string> = {
  default: "#166534",
  "allow-all": "#1D4ED8",
  "full-access": "#9F1239",
};

export interface IntroHeaderOptions {
  width: number;
  version: string;
  mode: string;
  provider: string;
  model: string;
  permissions: string;
  workdir: string;
  variant?: string | undefined;
  paintBorder?: ((text: string) => string) | undefined;
  theme?: Theme | undefined;
}

export function displayWorkdir(workdir: string, home: string = homedir()): string {
  if (!home) return workdir;
  if (workdir === home) return "~";
  const next = workdir.charAt(home.length);
  return workdir.startsWith(home) && (next === "/" || next === sep) ? `~${workdir.slice(home.length)}` : workdir;
}

function visibleWidth(text: string): number {
  return terminalWidth(text.replace(SGR, ""));
}

function fitCell(content: string, width: number, align: "left" | "center" = "left"): string {
  const len = visibleWidth(content);
  if (len > width) return middleClipText(content.replace(SGR, ""), width);
  const total = width - len;
  if (align === "left") return content + " ".repeat(total);
  const left = Math.floor(total / 2);
  return " ".repeat(left) + content + " ".repeat(total - left);
}

function plain(text: string): string {
  return text;
}

function effortOf(variant: string | undefined): string | undefined {
  return variant && variant !== "off" ? variant : undefined;
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

interface CardModel {
  readonly version: string;
  readonly mode: string;
  readonly provider: string;
  readonly model: string;
  readonly rawPermissions: string;
  readonly permissions: string;
  readonly effort: string | undefined;
  readonly cwd: string;
  readonly theme: Theme;
  readonly paintBorder: (text: string) => string;
}

function resolveCard(opts: IntroHeaderOptions): CardModel {
  const providerId = normalizeProvider(opts.provider || "openai");
  const rawPermissions = opts.permissions || DEFAULT_PERMISSION_MODE;
  return {
    version: opts.version || "0.0.0",
    mode: (opts.mode || "agent").toLowerCase(),
    provider: providerId ? getProvider(providerId).displayName : opts.provider || "openai",
    model: opts.model || "gpt-4",
    rawPermissions,
    permissions: permissionModeLabel(rawPermissions),
    effort: effortOf(opts.variant),
    cwd: opts.workdir,
    theme: opts.theme ?? themeFor("dark"),
    paintBorder: opts.paintBorder ?? cardBorder,
  };
}

function modeBadge(card: CardModel): string {
  const bg =
    card.mode === "ask" ? card.theme.chipTeal : card.mode === "plan" ? card.theme.chipIndigo : card.theme.mode;
  return chalk.bgHex(bg).whiteBright.bold(` ${card.mode.toUpperCase()} MODE `);
}

function permissionBadge(card: CardModel, withLabel: boolean): string {
  const bg = PERMISSION_BG[card.rawPermissions] ?? CHIP_BG;
  const value = chalk.bgHex(bg).whiteBright.bold(` ${card.permissions.toUpperCase()} `);
  return withLabel ? chalk.bgHex(CHIP_BG).whiteBright(" PERMS ") + value : value;
}

function badgeRows(card: CardModel, width: number): string[] {
  const mode = modeBadge(card);
  const labelled = permissionBadge(card, true);
  if (visibleWidth(mode) + 2 + visibleWidth(labelled) <= width) return [`${mode}  ${labelled}`];
  const perm = visibleWidth(labelled) <= width ? labelled : permissionBadge(card, false);
  return [mode, perm];
}

function infoRows(card: CardModel, width: number): string[] {
  const t = card.theme;
  const rows: [string, string, string, (s: string) => string][] = [
    ["workdir", "dir", card.cwd, plain],
    ["model", "model", card.model, chalk.hex(t.cyan)],
    ["provider", "prov", card.provider, chalk.hex(t.success)],
  ];
  if (card.effort) rows.push(["effort", "eff", card.effort, chalk.hex(t.magenta)]);

  const useShort = width < 30;
  const labelWidth = Math.max(...rows.map(([full, short]) => (useShort ? short : full).length));
  return rows.map(([full, short, value, ink]) => {
    const label = (useShort ? short : full).padEnd(labelWidth);
    const chip = chalk.bgHex(CHIP_BG).whiteBright.bold(` ${label} `);
    const room = Math.max(2, width - labelWidth - 3);
    return `${chip} ${ink(middleClipText(value, room))}`;
  });
}

function hintText(card: CardModel, entries: readonly [string, string][]): string {
  return entries
    .map(([key, label]) => chalk.hex(card.theme.cyan)(key) + (label ? chalk.hex(card.theme.muted)(` ${label}`) : ""))
    .join(chalk.hex(card.theme.hint)(" · "));
}

function welcomeLine(card: CardModel, budget: number): string {
  const greetings = [`Welcome to clai v${card.version}!`, `clai v${card.version}`];
  const candidates: [string, string][][] = [
    [["/help", "commands"], ["/history", "past chats"], ["shift+tab", "switch mode"]],
    [["/help", "commands"], ["/history", "past chats"]],
    [["/help", ""], ["/history", ""]],
    [["/help", ""]],
    [],
  ];
  for (const greeting of greetings) {
    for (const entries of candidates) {
      const hints = hintText(card, entries);
      const total = greeting.length + (entries.length > 0 ? 2 + visibleWidth(hints) : 0);
      if (total <= budget) {
        return chalk.hex(card.theme.success).bold(greeting) + (entries.length > 0 ? `  ${hints}` : "");
      }
    }
  }
  return chalk.hex(card.theme.success).bold(middleClipText(greetings[1]!, Math.max(1, budget)));
}

function renderIntroHeaderLinesInner(opts: IntroHeaderOptions): string[] {
  const card = resolveCard(opts);
  const { paintBorder } = card;
  const lead = " ".repeat(CARD_INSET_COLUMNS);

  const totalWidth = Math.max(24, opts.width);
  const OVERHEAD = 7;
  const available = Math.max(12, totalWidth - CARD_INSET_COLUMNS - OVERHEAD);

  const minSideBySide = Math.max(wordmarkWidth("clai") * 2, 36);
  if (available < minSideBySide) return renderCompactCard(card, totalWidth);

  const leftWidth = Math.floor(available / 2);
  const rightWidth = available - leftWidth;

  const wmLines = renderWordmark("clai", {
    indent: "",
    size: leftWidth >= wordmarkWidth("clai", "large") ? "large" : "compact",
  }).split("\n");

  const rightRows: string[] = [
    "",
    ...infoRows(card, rightWidth),
    "",
    ...badgeRows(card, rightWidth),
    "",
  ];
  const rowCount = Math.max(wmLines.length + 2, rightRows.length);

  const top = lead + paintBorder(`╭${"─".repeat(leftWidth + 2)}┬${"─".repeat(rightWidth + 2)}╮`);
  const bottom = lead + paintBorder(`╰${"─".repeat(leftWidth + 2)}┴${"─".repeat(rightWidth + 2)}╯`);

  const wmPadTop = Math.floor((rowCount - wmLines.length) / 2);
  const paddedWm = [...Array<string>(wmPadTop).fill(""), ...wmLines];
  const rightPadTop = Math.floor((rowCount - rightRows.length) / 2);
  const paddedRight = [...Array<string>(rightPadTop).fill(""), ...rightRows];

  const middle: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    const leftCell = fitCell(paddedWm[i] ?? "", leftWidth, "center");
    const rightCell = fitCell(paddedRight[i] ?? "", rightWidth);
    middle.push(
      lead + paintBorder("│") + ` ${leftCell} ` + paintBorder("│") + ` ${rightCell} ` + paintBorder("│"),
    );
  }

  const boxOuterWidth = CARD_INSET_COLUMNS + leftWidth + rightWidth + OVERHEAD;
  const centered = (text: string): string =>
    " ".repeat(Math.max(0, Math.floor((boxOuterWidth - visibleWidth(text)) / 2))) + text;

  const tagline =
    available >= 64
      ? "AI coding & security agent for the terminal · ask, plan & agent modes"
      : "AI coding & security agent";

  return [
    "",
    top,
    ...middle,
    bottom,
    "",
    centered(middleClipText(tagline, boxOuterWidth)),
    centered(welcomeLine(card, boxOuterWidth)),
  ];
}

function renderCompactCard(card: CardModel, totalWidth: number): string[] {
  const { paintBorder } = card;
  const lead = " ".repeat(CARD_INSET_COLUMNS);
  const rule = Math.max(8, totalWidth - CARD_INSET_COLUMNS - 2);
  const inner = Math.max(6, rule - 2);
  const row = (content: string, align: "left" | "center" = "left"): string =>
    lead + paintBorder("│") + ` ${fitCell(content, inner, align)} ` + paintBorder("│");

  const wmLines =
    inner >= wordmarkWidth("clai")
      ? renderWordmark("clai", { indent: "" }).split("\n")
      : [chalk.hex(CARD_BORDER_HEX).bold("clai")];
  const lines: string[] = ["", lead + paintBorder(`╭${"─".repeat(rule)}╮`)];
  for (const wm of wmLines) lines.push(row(wm, "center"));
  lines.push(row(""));
  for (const info of infoRows(card, inner)) lines.push(row(info));
  lines.push(row(""));
  for (const badge of badgeRows(card, inner)) lines.push(row(badge));
  lines.push(lead + paintBorder(`╰${"─".repeat(rule)}╯`));
  lines.push("");
  lines.push(lead + welcomeLine(card, Math.max(1, totalWidth - CARD_INSET_COLUMNS)));
  return lines;
}
