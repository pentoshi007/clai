import chalk from "chalk";
import { homedir } from "node:os";

// ── Box drawing helpers ─────────────────────────────────────────────────────

function stripAnsi(str: string): string {
  // biome-ignore lint: escape sequences are intentional
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function box(
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
  return [top, ...padded, bottom].map(line => `  ${line}`).join("\n");
}

// ── Public rendering functions ──────────────────────────────────────────────

export function renderBanner(version: string): string {
  return box(
    [`${chalk.magenta("●")} ${chalk.bold.white("clai")} ${chalk.dim(`v${version}`)}`],
    { minWidth: 58 },
  );
}

export function renderSessionInfo(opts: {
  workdir: string;
  model: string;
  provider: string;
  mode: string;
}): string {
  const home = homedir();
  const workdir = opts.workdir.startsWith(home)
    ? `~${opts.workdir.slice(home.length)}`
    : opts.workdir;

  return box(
    [
      `${chalk.dim("↳ workdir:")}  ${workdir}`,
      `${chalk.dim("↳ model:")}    ${chalk.cyan(opts.model)}`,
      `${chalk.dim("↳ provider:")} ${chalk.green(opts.provider)}`,
      `${chalk.dim("↳ mode:")}     ${chalk.yellow(opts.mode)}`,
    ],
    { minWidth: 58 },
  );
}

export function renderSuggestions(): string {
  const suggestions = [
    "scan my network",
    "recon example.com",
    "directory bruteforce on 192.168.1.1",
    "find open ports on target",
  ];
  return chalk.dim("  try: ") + chalk.dim.italic(suggestions.join(" │ "));
}

export function renderModeSwitch(mode: string): string {
  return box(
    [`${chalk.dim("mode →")} ${chalk.yellow(mode)}`],
    { minWidth: 30 },
  );
}

export function renderProviderSwitch(provider: string, model: string): string {
  return box(
    [
      `${chalk.dim("provider →")} ${chalk.green(provider)}`,
      `${chalk.dim("model →")}    ${chalk.cyan(model)}`,
    ],
    { minWidth: 30 },
  );
}

export const PROMPT = `  ${chalk.magenta("❯")} `;
export const PROMPT_SECONDARY = `  ${chalk.gray("…")} `;
