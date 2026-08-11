import chalk from "chalk";

// A 5x7 dot-matrix rendering of "CLAI", kept as plain glyph data so no
// figlet/gradient-string dependency is needed just for a startup banner.
const GLYPHS: Record<string, string[]> = {
  C: [" ███ ", "█   █", "█    ", "█    ", "█    ", "█   █", " ███ "],
  L: ["█    ", "█    ", "█    ", "█    ", "█    ", "█    ", "█████"],
  A: [" ███ ", "█   █", "█   █", "█████", "█   █", "█   █", "█   █"],
  I: ["█████", "  █  ", "  █  ", "  █  ", "  █  ", "  █  ", "█████"],
};

/**
 * Truecolor hex for the top row of the wordmark (chalk.magentaBright) — the
 * top of the "I". Shared by intro-card + plan/task pane borders.
 */
export const WORDMARK_TOP_HEX = "#FF55FF";

/** Per-row colors, applied top-to-bottom for a subtle vertical gradient. */
const GRADIENT = [
  chalk.hex(WORDMARK_TOP_HEX), // top of "I"
  chalk.magenta,
  chalk.blueBright,
  chalk.cyanBright,
  chalk.cyan,
  chalk.blueBright,
  chalk.magenta,
];

/** Width (in columns, uncolored) of the rendered wordmark for a given word. */
export function wordmarkWidth(word: string): number {
  const letters = word.toUpperCase().split("");
  return letters.reduce((w, ch) => w + (GLYPHS[ch]?.[0]?.length ?? 5), 0) +
    Math.max(0, letters.length - 1) * 2;
}

/**
 * Render `word` as a gradient-colored dot-matrix wordmark, one string per
 * row, joined with newlines. Each line is prefixed by `indent` spaces.
 */
export function renderWordmark(word: string, indent = "  "): string {
  const letters = word.toUpperCase().split("");
  const rows = 7;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells = letters
      .map((ch) => GLYPHS[ch] ?? GLYPHS.I ?? [])
      .map((g) => g[r] ?? "");
    lines.push(GRADIENT[r]?.(cells.join("  ")) ?? cells.join("  "));
  }
  return lines.map((l) => `${indent}${l}`).join("\n");
}
