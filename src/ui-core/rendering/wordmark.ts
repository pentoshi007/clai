import chalk from "chalk";

const COMPACT_I: readonly string[] = [
  "##",
  "##",
  "..",
  "..",
  "##",
  "##",
  "##",
  "##",
];

const COMPACT_GLYPHS: Record<string, readonly string[]> = {
  c: [
    "......",
    ".####.",
    "##....",
    "##....",
    "##....",
    "##....",
    "##....",
    ".####.",
  ],
  l: ["##", "##", "##", "##", "##", "##", "##", "##"],
  a: [
    "......",
    ".####.",
    "....##",
    ".#####",
    "##..##",
    "##..##",
    "##..##",
    ".#####",
  ],
  i: COMPACT_I,
};

const LARGE_I: readonly string[] = [
  "###",
  "###",
  "...",
  "...",
  "###",
  "###",
  "###",
  "###",
  "###",
  "###",
  "###",
  "###",
];

const LARGE_GLYPHS: Record<string, readonly string[]> = {
  c: [
    ".........",
    ".........",
    ".........",
    ".#######.",
    "#########",
    "###......",
    "###......",
    "###......",
    "###......",
    "###......",
    "#########",
    ".#######.",
  ],
  l: [
    "###",
    "###",
    "###",
    "###",
    "###",
    "###",
    "###",
    "###",
    "###",
    "###",
    "###",
    "###",
  ],
  a: [
    ".........",
    ".........",
    ".........",
    ".#######.",
    "......###",
    "......###",
    ".########",
    "###...###",
    "###...###",
    "###...###",
    "###...###",
    ".########",
  ],
  i: LARGE_I,
};

export type WordmarkStyle = "block" | "ascii";

export type WordmarkSize = "compact" | "large";

export interface WordmarkOptions {
  readonly indent?: string;
  readonly style?: WordmarkStyle;
  readonly size?: WordmarkSize;
}

interface Spec {
  readonly rows: number;
  readonly gap: number;
  readonly glyphs: Record<string, readonly string[]>;
  readonly fallback: readonly string[];
}

const SPECS: Record<WordmarkSize, Spec> = {
  compact: { rows: 4, gap: 2, glyphs: COMPACT_GLYPHS, fallback: COMPACT_I },
  large: { rows: 6, gap: 2, glyphs: LARGE_GLYPHS, fallback: LARGE_I },
};

const ON = "#";

export const WORDMARK_TOP_HEX = "#12D9B0";

const RAMP: readonly string[] = [
  WORDMARK_TOP_HEX,
  "#1FE4DA",
  "#2EEBFF",
  "#8FEFFF",
];

const RAMP_STEPS = 12;

function glyphsOf(word: string, spec: Spec): readonly string[][] {
  return [...word.toLowerCase()].map((char) => [
    ...(spec.glyphs[char] ?? spec.fallback),
  ]);
}

export function wordmarkWidth(word: string, size: WordmarkSize = "compact"): number {
  const spec = SPECS[size];
  const glyphs = glyphsOf(word, spec);
  const letters = glyphs.reduce(
    (total, glyph) => total + (glyph[0]?.length ?? 0),
    0,
  );
  return letters + Math.max(0, glyphs.length - 1) * spec.gap;
}

function cell(top: boolean, bottom: boolean, style: WordmarkStyle): string {
  if (style === "ascii") return bottom ? ON : " ";
  if (top && bottom) return "█";
  if (top) return "▀";
  if (bottom) return "▄";
  return " ";
}

function plainRows(word: string, style: WordmarkStyle, spec: Spec): string[] {
  const glyphs = glyphsOf(word, spec);
  const rows: string[] = [];
  for (let row = 0; row < spec.rows; row += 1) {
    const cells = glyphs.map((glyph) => {
      const upper = glyph[row * 2] ?? "";
      const lower = glyph[row * 2 + 1] ?? "";
      const width = Math.max(upper.length, lower.length);
      let out = "";
      for (let column = 0; column < width; column += 1) {
        out += cell(upper[column] === ON, lower[column] === ON, style);
      }
      return out;
    });
    rows.push(cells.join(" ".repeat(spec.gap)));
  }
  return rows;
}

function channels(hex: string): readonly number[] {
  return [1, 3, 5].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16),
  );
}

function rampHex(position: number): string {
  const clamped = Math.min(1, Math.max(0, position));
  const span = (RAMP.length - 1) * clamped;
  const index = Math.min(RAMP.length - 2, Math.floor(span));
  const from = channels(RAMP[index] ?? WORDMARK_TOP_HEX);
  const to = channels(RAMP[index + 1] ?? WORDMARK_TOP_HEX);
  const local = span - index;
  const mixed = from.map((value, channel) =>
    Math.round(value + ((to[channel] ?? value) - value) * local),
  );
  return `#${mixed.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function columnHex(column: number, width: number): string {
  if (width <= 1) return rampHex(0);
  const step = Math.round((column / (width - 1)) * (RAMP_STEPS - 1));
  return rampHex(step / (RAMP_STEPS - 1));
}

function paintRow(row: string, width: number): string {
  let out = "";
  let run = "";
  let runHex = "";
  const flush = (): void => {
    if (run.length === 0) return;
    out += runHex.length > 0 ? chalk.hex(runHex)(run) : run;
    run = "";
  };
  for (let column = 0; column < row.length; column += 1) {
    const char = row[column] ?? " ";
    const hex = char === " " ? "" : columnHex(column, width);
    if (hex !== runHex) {
      flush();
      runHex = hex;
    }
    run += char;
  }
  flush();
  return out;
}

export function renderWordmark(
  word: string,
  options: WordmarkOptions = {},
): string {
  const { indent = "  ", style = "block", size = "compact" } = options;
  const width = wordmarkWidth(word, size);
  return plainRows(word, style, SPECS[size])
    .map((row) => `${indent}${paintRow(row, width)}`)
    .join("\n");
}
