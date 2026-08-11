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

function termWidth(): number {
  return process.stdout.columns ?? 80;
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return max > 3 ? str.slice(0, max - 1) + "…" : str.slice(0, max);
}

function displayPermissions(permissions: string): string {
  return permissions === "allow-all" ? "auto-allow" : permissions;
}

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

  const tagline = "AI-powered terminal assistant · ask & agent modes for shell, files & security workflows";
  parts.push(`  ${chalk.white(truncate(tagline, cols - 4))}`);

  parts.push(
    `  ${chalk.green("Welcome to clai")} ${chalk.green.bold(`v${opts.version}`)}${chalk.green("!")} ${chalk.cyan("/help for commands.")}`,
  );
  parts.push("");

  const boxMinWidth = Math.min(58, cols - 8);
  const maxVal = Math.max(20, cols - 22);
  const displayPerm = displayPermissions(opts.permissions);
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

  const permColor = opts.permissions === "allow-all" ? "#16a34a" : "#475569";
  const modeBadge = chalk.bgHex("#B45309").whiteBright.bold(
    `  ${opts.mode.toUpperCase()} MODE  `,
  );
  const permBadge = chalk.bgHex(permColor).whiteBright.bold(
    `  ${displayPerm.toUpperCase()}  `,
  );
  const badgeLine = `  ${modeBadge}  ${permBadge}`;
  const badgeVisLen = opts.mode.length + 8 + displayPerm.length + 4 + 6;
  if (badgeVisLen > cols) {
    parts.push(`  ${modeBadge}`);
    parts.push(`  ${permBadge}`);
  } else {
    parts.push(badgeLine);
  }

  const fullShortcuts =
    "ESC×2 cancel all  │  Ctrl+C quit  │  @ files  │  /history past chats  │  Ctrl+T thinking  │  Ctrl+O output";
  const shortShortcuts =
    "ESC×2 cancel │ Ctrl+C quit │ @ files │ /history │ Ctrl+T think │ Ctrl+O out";
  const miniShortcuts =
    "ESC×2 cancel │ /history │ /help";
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
