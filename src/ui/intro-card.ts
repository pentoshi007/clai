import chalk from "chalk";
import { homedir } from "node:os";
import { box } from "./ansi-box.js";

// A 5x7 dot-matrix rendering of "CLAI", plain data so no figlet dependency
// is needed for a one-time startup card.
const GLYPHS: Record<string, string[]> = {
  C: [" ███ ", "█   █", "█    ", "█    ", "█    ", "█   █", " ███ "],
  L: ["█    ", "█    ", "█    ", "█    ", "█    ", "█    ", "█████"],
  A: [" ███ ", "█   █", "█   █", "█████", "█   █", "█   █", "█   █"],
  I: ["█████", "  █  ", "  █  ", "  █  ", "  █  ", "  █  ", "█████"],
};

/** Per-row colors, applied top-to-bottom for a subtle vertical gradient. */
const GRADIENT = [
  chalk.magentaBright,
  chalk.magenta,
  chalk.blueBright,
  chalk.cyanBright,
  chalk.cyan,
  chalk.blueBright,
  chalk.magenta,
];

function renderWordmark(word: string): string {
  const letters = word.toUpperCase().split("");
  const rows = 7;
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const cells = letters.map((ch) => GLYPHS[ch] ?? GLYPHS.I ?? []).map((g) => g[r] ?? "");
    lines.push(GRADIENT[r]?.(cells.join("  ")) ?? cells.join("  "));
  }
  return lines.map((l) => `  ${l}`).join("\n");
}

export interface IntroCardOptions {
  version: string;
  workdir: string;
  model: string;
  provider: string;
  mode: string;
}

/** Startup intro: wordmark, tagline, and a session-info card. */
export function renderIntroCard(opts: IntroCardOptions): string {
  const home = homedir();
  const workdir = opts.workdir.startsWith(home)
    ? `~${opts.workdir.slice(home.length)}`
    : opts.workdir;

  const parts: string[] = [];

  parts.push("");
  parts.push(renderWordmark("CLAI"));
  parts.push("");
  parts.push(
    `  ${chalk.dim("AI-powered terminal assistant · ask & agent modes for shell, files & security workflows")}`,
  );
  parts.push(
    `  ${chalk.green("Welcome to clai")} ${chalk.green.bold(`v${opts.version}`)}${chalk.green("!")} ${chalk.dim("/help for commands.")}`,
  );
  parts.push("");
  parts.push(
    box(
      [
        `${chalk.dim("↳ workdir:")}  ${workdir}`,
        `${chalk.dim("↳ model:")}    ${chalk.cyan(opts.model)}`,
        `${chalk.dim("↳ provider:")} ${chalk.green(opts.provider)}`,
        `${chalk.dim("↳ mode:")}     ${chalk.yellow(opts.mode)}`,
        `${chalk.dim("↳ version:")}  ${chalk.white(opts.version)}`,
      ],
      { minWidth: 58 },
    ),
  );
  parts.push("");
  parts.push(renderIntroSuggestions());
  parts.push(
    chalk.dim(
      "  ESC abort  │  Ctrl+C clears input  │  @ to attach files  │  Ctrl+T thinking  │  Ctrl+O tool output  │  Ctrl+P plan (q to close)",
    ),
  );

  return parts.join("\n");
}

export function renderIntroSuggestions(): string {
  const suggestions = [
    "scan my network",
    "recon example.com",
    "create a react app here",
    "explain @file.ts",
  ];
  return chalk.dim("  try: ") + chalk.dim.italic(suggestions.join(" │ "));
}
