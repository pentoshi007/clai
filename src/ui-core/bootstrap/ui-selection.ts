import { MIN_COLS, MIN_ROWS } from "./can-use-tui.js";

export type UiChoice = "tui" | "classic" | "noninteractive";

export interface UiSelectionOptions {
  readonly ui?: string | undefined;
  readonly tui?: boolean | undefined;
  readonly classic?: boolean | undefined;
}

export interface PlatformProbe {
  readonly platform: NodeJS.Platform;
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
}

export type UiChoiceSource =
  | "ui-flag"
  | "classic-flag"
  | "tui-flag"
  | "clai-ui-env"
  | "classic-env"
  | "plain-env"
  | "platform-default";

export interface UiSelectionExplanation {
  readonly choice: UiChoice;
  readonly source: UiChoiceSource;
  readonly reason: string;
}

export const UI_FLAG_CHOICES = [
  "tui",
  "v2",
  "opentui",
  "classic",
  "legacy",
  "ink",
] as const;

const UI_TOKEN_ALIASES: Readonly<Record<string, UiChoice>> = {
  tui: "tui",
  v2: "tui",
  opentui: "tui",
  classic: "classic",
  legacy: "classic",
  ink: "classic",
};

export function normalizeUiToken(value: string | undefined): UiChoice | undefined {
  const token = value?.trim().toLowerCase();
  if (!token) return undefined;
  return UI_TOKEN_ALIASES[token];
}

export function defaultUiForPlatform(input: PlatformProbe): UiChoice {
  if (!input.stdoutIsTTY || !input.stdinIsTTY) return "noninteractive";
  if (input.platform === "win32") return "classic";
  const columns = input.columns ?? 0;
  const rows = input.rows ?? 0;
  if (columns < MIN_COLS || rows < MIN_ROWS) return "classic";
  return "tui";
}

export function currentPlatformProbe(): PlatformProbe {
  return {
    platform: process.platform,
    stdoutIsTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  };
}

export function explainUiChoice(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
  platform: PlatformProbe = currentPlatformProbe(),
): UiSelectionExplanation {
  const fromFlag = normalizeUiToken(options.ui);
  if (fromFlag) {
    return {
      choice: fromFlag,
      source: "ui-flag",
      reason: `--ui ${options.ui?.trim().toLowerCase()}`,
    };
  }

  if (options.classic) {
    return { choice: "classic", source: "classic-flag", reason: "--classic" };
  }

  if (options.tui) {
    return { choice: "tui", source: "tui-flag", reason: "--tui" };
  }

  const fromEnv = normalizeUiToken(env.CLAI_UI);
  if (fromEnv) {
    return {
      choice: fromEnv,
      source: "clai-ui-env",
      reason: `CLAI_UI=${env.CLAI_UI?.trim().toLowerCase()}`,
    };
  }

  if (env.CLAI_CLASSIC === "1") {
    return { choice: "classic", source: "classic-env", reason: "CLAI_CLASSIC=1" };
  }

  if (env.CLAI_TUI === "0") {
    return { choice: "classic", source: "classic-env", reason: "CLAI_TUI=0" };
  }

  if (env.CLAI_CLASSIC_UI?.trim().toLowerCase() === "plain") {
    return {
      choice: "noninteractive",
      source: "plain-env",
      reason: "CLAI_CLASSIC_UI=plain",
    };
  }

  const choice = defaultUiForPlatform(platform);
  return {
    choice,
    source: "platform-default",
    reason: platformDefaultReason(choice, platform),
  };
}

function platformDefaultReason(choice: UiChoice, platform: PlatformProbe): string {
  if (choice === "noninteractive") {
    if (!platform.stdoutIsTTY && !platform.stdinIsTTY) return "stdin and stdout are not TTYs";
    return platform.stdoutIsTTY ? "stdin is not a TTY" : "stdout is not a TTY";
  }
  if (choice === "classic") {
    if (platform.platform === "win32") return "platform default for win32";
    return `terminal smaller than ${MIN_COLS}x${MIN_ROWS} (${platform.columns ?? 0}x${platform.rows ?? 0})`;
  }
  return "platform default for an interactive terminal";
}

export function resolveUiChoice(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
  platform: PlatformProbe = currentPlatformProbe(),
): UiChoice {
  return explainUiChoice(options, env, platform).choice;
}

export function isTuiRequested(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
  platform: PlatformProbe = currentPlatformProbe(),
): boolean {
  return resolveUiChoice(options, env, platform) === "tui";
}

export function describeUiDefault(): string {
  return `tui (OpenTUI) on an interactive POSIX terminal at least ${MIN_COLS}x${MIN_ROWS}; classic Ink UI on Windows or a smaller POSIX terminal; noninteractive when stdin or stdout is not a TTY`;
}
