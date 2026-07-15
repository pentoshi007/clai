import chalk from "chalk";
import { homedir } from "node:os";
import { box } from "./ansi-box.js";
import { renderWordmark } from "./wordmark.js";

export interface IntroCardOptions {
  version: string;
  workdir: string;
  model: string;
  provider: string;
  mode: string;
  permissions: string;
}

/** Terminal width, clamped to a sensible band. */
function termWidth(): number {
  return process.stdout.columns ?? 80;
}

/** Truncate a string (ANSI-unaware) to fit within `max` visible chars. */
function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return max > 3 ? str.slice(0, max - 1) + "…" : str.slice(0, max);
}

/** Startup intro: wordmark, tagline, and a session-info card. */
export function renderIntroCard(opts: IntroCardOptions): string {
  const cols = termWidth();
  const home = homedir();
  const workdir = opts.workdir.startsWith(home)
    ? `~${opts.workdir.slice(home.length)}`
    : opts.workdir;

  const parts: string[] = [];

  parts.push("");
  parts.push(renderWordmark("CLAI"));
  parts.push("");

  // Tagline — truncate if terminal is very narrow
  const tagline = "AI-powered terminal assistant · ask & agent modes for shell, files & security workflows";
  parts.push(`  ${chalk.white(truncate(tagline, cols - 4))}`);

  parts.push(
    `  ${chalk.green("Welcome to clai")} ${chalk.green.bold(`v${opts.version}`)}${chalk.green("!")} ${chalk.cyan("/help for commands.")}`,
  );
  parts.push("");

  // Box — clamp minWidth to terminal width (minus box borders + padding = 8 chars)
  const boxMinWidth = Math.min(58, cols - 8);
  // Also truncate long values so they fit in the box
  const maxVal = Math.max(20, cols - 22); // label is ~14 chars + borders ~8
  parts.push(
    box(
      [
        `${chalk.dim("↳ workdir:")}     ${truncate(workdir, maxVal)}`,
        `${chalk.dim("↳ model:")}       ${chalk.cyan(truncate(opts.model, maxVal))}`,
        `${chalk.dim("↳ provider:")}    ${chalk.green(truncate(opts.provider, maxVal))}`,
        `${chalk.dim("↳ mode:")}        ${chalk.yellow(opts.mode)}`,
        `${chalk.dim("↳ version:")}     ${chalk.white(opts.version)}`,
      ],
      { minWidth: Math.max(20, boxMinWidth) },
    ),
  );
  parts.push("");

  // Mode + permission badges — stack vertically on narrow terminals
  const permColor = opts.permissions === "allow-all" ? "#16a34a" : "#475569";
  const modeBadge = chalk.bgHex("#B45309").whiteBright.bold(
    `  ${opts.mode.toUpperCase()} MODE  `,
  );
  const permBadge = chalk.bgHex(permColor).whiteBright.bold(
    `  ${opts.permissions.toUpperCase()}  `,
  );
  const badgeLine = `  ${modeBadge}  ${permBadge}`;
  // "  AGENT MODE    ALLOW-ALL  " is ~30 visible chars; safe for most widths
  // But measure it properly: each badge is mode.len+8 + perm.len+4 + gaps
  const badgeVisLen = opts.mode.length + 8 + opts.permissions.length + 4 + 6;
  if (badgeVisLen > cols) {
    // Stack them vertically
    parts.push(`  ${modeBadge}`);
    parts.push(`  ${permBadge}`);
  } else {
    parts.push(badgeLine);
  }

  // Shortcuts — pick a set that fits the terminal width
  const fullShortcuts =
    "ESC abort  │  Ctrl+C quit  │  @ files  │  /history past chats  │  Ctrl+T thinking  │  Ctrl+O output";
  const shortShortcuts =
    "ESC abort │ Ctrl+C quit │ @ files │ /history │ Ctrl+T think │ Ctrl+O out";
  const miniShortcuts =
    "ESC abort │ /history │ /help";
  const shortcutsText =
    cols >= 110
      ? fullShortcuts
      : cols >= 80
        ? shortShortcuts
        : miniShortcuts;
  parts.push(chalk.dim(`  ${truncate(shortcutsText, cols - 4)}`));

  return parts.join("\n");
}

export function renderIntroSuggestions(): string {
  return "";
}
