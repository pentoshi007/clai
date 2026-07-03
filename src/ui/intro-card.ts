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
    `  ${chalk.white("AI-powered terminal assistant · ask & agent modes for shell, files & security workflows")}`,
  );
  parts.push(
    `  ${chalk.green("Welcome to clai")} ${chalk.green.bold(`v${opts.version}`)}${chalk.green("!")} ${chalk.cyan("/help for commands.")}`,
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
  parts.push(
    `  ${chalk.bgHex("#B45309").whiteBright.bold(`  ${opts.mode.toUpperCase()} MODE  `)} ${chalk.dim("execution policy is active")}`,
  );
  parts.push(
    chalk.dim(
      "  ESC abort  │  Ctrl+C clears input  │  @ to attach files  │  Ctrl+T thinking  │  Ctrl+O tool output  │  Ctrl+P plan (q to close)",
    ),
  );

  return parts.join("\n");
}

export function renderIntroSuggestions(): string {
  return "";
}
