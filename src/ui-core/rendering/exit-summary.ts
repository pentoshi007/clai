import chalk from "chalk";
import { type SessionUsageReport, type SessionUsageTotals } from "../../app/controllers/session-usage-ledger.js";
import { formatDurationMs } from "./duration.js";
import { renderColumns } from "./text-width.js";
import {
  renderWordmark,
  wordmarkWidth,
  type WordmarkSize,
} from "./wordmark.js";
import { Glyphs, IDENTITY, Paint, Palette, count, padEnd, plural, tableLines, truncateEnd, truncateMiddle } from "./exit-summary/table.js";

const BRAND_HEX = "#2EEBFF";
const MISSING = "—";
const MISSING_ASCII = "-";
const INDENT = "  ";
const LOGO_GAP = 4;
const LOGO_GAP_TIGHT = 2;
const MIN_WIDTH = 16;
const MIN_INFO = 24;

export interface ExitSummaryInput {
  readonly usage: SessionUsageReport;
  readonly sessionId: string;
  readonly title?: string | undefined;
  readonly messages: number;
  readonly cwd: string;
  readonly durationMs: number;
  readonly resumable: boolean;
  readonly width: number;
  readonly color: boolean;
  readonly unicode: boolean;
}

export function resumeCommand(sessionId: string): string {
  return `clai --resume ${sessionId}`;
}

function palette(color: boolean): Palette {
  if (!color) {
    return {
      brand: IDENTITY,
      title: IDENTITY,
      muted: IDENTITY,
      label: IDENTITY,
      value: IDENTITY,
      total: IDENTITY,
      command: IDENTITY,
    };
  }
  return {
    brand: (text) => chalk.bold.hex(BRAND_HEX)(text),
    title: (text) => chalk.bold.whiteBright(text),
    muted: (text) => chalk.dim(text),
    label: (text) => chalk.gray(text),
    value: (text) => chalk.whiteBright(text),
    total: (text) => chalk.bold.cyanBright(text),
    command: (text) => chalk.bold.hex(BRAND_HEX)(text),
  };
}

const UNICODE_GLYPHS: Glyphs = {
  horizontal: "─",
  bullet: "·",
  missing: MISSING,
};

const ASCII_GLYPHS: Glyphs = {
  horizontal: "-",
  bullet: "-",
  missing: MISSING_ASCII,
};

function footnotes(totals: SessionUsageTotals, glyphs: Glyphs): string[] {
  const notes: string[] = [];
  if (totals.reasoningTokens !== undefined && totals.reasoningTokens > 0) {
    notes.push(`reasoning ${count(totals.reasoningTokens)}`);
  } else if (totals.reasoningObserved) {
    notes.push("reasoning observed");
  }
  if (totals.cacheCreationTokens !== undefined && totals.cacheCreationTokens > 0) {
    notes.push(`cache write ${count(totals.cacheCreationTokens)}`);
  }
  if (totals.estimatedRequests > 0) {
    notes.push(plural(totals.estimatedRequests, "estimated request"));
  }
  if (totals.unmeasuredPromptRequests > 0) {
    notes.push(
      `${plural(totals.unmeasuredPromptRequests, "request")} without an input count`,
    );
  }
  if (totals.cachedPromptTokens === undefined) {
    notes.push(`cache ${glyphs.missing} not reported`);
  }
  return notes;
}

function shortenPath(path: string, width: number): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const shown = home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
  return truncateMiddle(shown, width);
}

interface InfoLine {
  readonly plain: string;
  readonly painted: string;
}

const NOT_SAVED_TAIL = "cannot be resumed";

const LABELS = {
  session: "Session",
  folder: "Folder",
  worked: "Worked",
  tokens: "Tokens",
  resume: "Resume",
} as const;

const LABEL_GAP = 2;

function labelColumn(): number {
  return Object.values(LABELS).reduce(
    (widest, label) => Math.max(widest, renderColumns(label)),
    0,
  );
}

function workedText(input: ExitSummaryInput, glyphs: Glyphs): string {
  const parts = [
    ...(input.durationMs > 0 ? [formatDurationMs(input.durationMs)] : []),
    plural(input.messages, "message"),
  ];
  return parts.join(` ${glyphs.bullet} `);
}

function notSavedText(glyphs: Glyphs): string {
  return `not saved ${glyphs.bullet} ${NOT_SAVED_TAIL}`;
}

interface InfoRow {
  readonly label: string;
  readonly value: string;
  readonly paint: Paint;
}

function hardValueWidth(input: ExitSummaryInput, glyphs: Glyphs): number {
  const value = input.resumable
    ? resumeCommand(input.sessionId)
    : notSavedText(glyphs);
  return labelColumn() + LABEL_GAP + renderColumns(value);
}

function infoLines(
  input: ExitSummaryInput,
  colors: Palette,
  glyphs: Glyphs,
  room: number,
  notes: string,
): InfoLine[] {
  const labelled = hardValueWidth(input, glyphs) <= room;
  const label = labelled ? labelColumn() : 0;
  const gap = " ".repeat(labelled ? LABEL_GAP : 0);
  const valueRoom = Math.max(6, room - label - gap.length);
  const title = input.title?.trim();
  const rows: InfoRow[] = [
    ...(title
      ? [
          {
            label: LABELS.session,
            value: truncateEnd(title, valueRoom),
            paint: colors.title,
          },
        ]
      : []),
    {
      label: LABELS.folder,
      value: shortenPath(input.cwd, valueRoom),
      paint: colors.value,
    },
    {
      label: LABELS.worked,
      value: truncateEnd(workedText(input, glyphs), valueRoom),
      paint: colors.value,
    },
    ...(notes.length > 0
      ? [
          {
            label: LABELS.tokens,
            value: truncateEnd(notes, valueRoom),
            paint: colors.muted,
          },
        ]
      : []),
    input.resumable
      ? {
          label: LABELS.resume,
          value: truncateEnd(resumeCommand(input.sessionId), valueRoom),
          paint: colors.command,
        }
      : {
          label: LABELS.resume,
          value: truncateEnd(notSavedText(glyphs), valueRoom),
          paint: colors.muted,
        },
  ];
  return rows.map((row) => {
    const shown = labelled ? padEnd(row.label, label) : "";
    return {
      plain: shown + gap + row.value,
      painted: colors.muted(shown) + gap + row.paint(row.value),
    };
  });
}

interface LogoBlock {
  readonly lines: readonly string[];
  readonly width: number;
}

const LOGO_SIZES: readonly WordmarkSize[] = ["large", "compact"];

function wordmarkBlock(unicode: boolean, size: WordmarkSize): LogoBlock {
  return {
    lines: renderWordmark("clai", {
      indent: "",
      style: unicode ? "block" : "ascii",
      size,
    }).split("\n"),
    width: wordmarkWidth("clai", size),
  };
}

function logoBlock(
  unicode: boolean,
  available: number,
  colors: Palette,
): LogoBlock {
  for (const size of LOGO_SIZES) {
    if (wordmarkWidth("clai", size) <= available) {
      return wordmarkBlock(unicode, size);
    }
  }
  const text = "c l a i";
  return { lines: [colors.brand(text)], width: renderColumns(text) };
}

function sideBySide(
  logo: LogoBlock,
  info: readonly InfoLine[],
  gap: number,
): string[] {
  const offset = Math.max(0, Math.floor((logo.lines.length - info.length) / 2));
  const rows = Math.max(logo.lines.length, offset + info.length);
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const left = logo.lines[row];
    const right = info[row - offset];
    if (right === undefined || right.plain.length === 0) {
      lines.push(left === undefined ? "" : INDENT + left);
      continue;
    }
    const lead =
      left === undefined ? " ".repeat(logo.width) : padEnd(left, logo.width);
    lines.push(INDENT + lead + " ".repeat(gap) + right.painted);
  }
  return lines;
}

function stacked(logo: LogoBlock, info: readonly InfoLine[]): string[] {
  return [
    ...logo.lines.map((line) => INDENT + line),
    "",
    ...info.map((line) =>
      line.plain.length === 0 ? "" : INDENT + line.painted,
    ),
  ];
}

function bannerLines(
  input: ExitSummaryInput,
  colors: Palette,
  glyphs: Glyphs,
  available: number,
  notes: string,
): string[] {
  const required = Math.max(MIN_INFO, hardValueWidth(input, glyphs));
  for (const size of LOGO_SIZES) {
    const logo = wordmarkBlock(input.unicode, size);
    for (const gap of [LOGO_GAP, LOGO_GAP_TIGHT]) {
      const room = available - logo.width - gap;
      if (room >= required) {
        return sideBySide(
          logo,
          infoLines(input, colors, glyphs, room, notes),
          gap,
        );
      }
    }
  }
  const logo = logoBlock(input.unicode, available, colors);
  return stacked(logo, infoLines(input, colors, glyphs, available, notes));
}

function usageSection(
  input: ExitSummaryInput,
  colors: Palette,
  glyphs: Glyphs,
  available: number,
): string[] {
  if (input.usage.routes.length === 0) {
    return [
      INDENT +
        colors.muted(
          truncateEnd("No provider token usage was recorded.", available),
        ),
    ];
  }
  return tableLines(input.usage, available, colors, glyphs).map(
    (line) => INDENT + line,
  );
}

export function renderExitSummaryLines(input: ExitSummaryInput): string[] {
  const previousLevel = chalk.level;
  try {
    if (!input.color) chalk.level = 0;
    else if (chalk.level < 1) chalk.level = 3;
    return build(input);
  } finally {
    chalk.level = previousLevel;
  }
}

function build(input: ExitSummaryInput): string[] {
  const colors = palette(input.color);
  const glyphs = input.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS;
  const width = Math.max(MIN_WIDTH, Math.floor(input.width) || 80);
  const available = width - INDENT.length;
  const notes =
    input.usage.routes.length === 0
      ? ""
      : footnotes(input.usage.totals, glyphs).join(` ${glyphs.bullet} `);
  return [
    "",
    ...bannerLines(input, colors, glyphs, available, notes),
    "",
    ...usageSection(input, colors, glyphs, available),
    "",
  ];
}

export function renderExitSummary(input: ExitSummaryInput): string {
  return `${renderExitSummaryLines(input).join("\n")}\n`;
}
