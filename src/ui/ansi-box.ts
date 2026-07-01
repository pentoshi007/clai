import chalk from "chalk";

export const ANSI_SGR_PATTERN = /\x1b\[[0-9;]*m/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_SGR_PATTERN, "");
}

/** Draws a bordered box around the given lines, padded to a common width. */
export function box(
  lines: string[],
  opts: { color?: (s: string) => string; minWidth?: number } = {},
): string {
  const color = opts.color ?? chalk.gray;
  const contentWidth = Math.max(
    opts.minWidth ?? 60,
    ...lines.map((l) => stripAnsi(l).length),
  );
  const top = color(`╭${"─".repeat(contentWidth + 2)}╮`);
  const bottom = color(`╰${"─".repeat(contentWidth + 2)}╯`);
  const padded = lines.map((l) => {
    const pad = contentWidth - stripAnsi(l).length;
    return `${color("│")} ${l}${" ".repeat(Math.max(0, pad))} ${color("│")}`;
  });
  return [top, ...padded, bottom].map((line) => `  ${line}`).join("\n");
}
