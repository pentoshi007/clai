export interface TuiSelectionOptions {
  tui?: boolean | undefined;
  classic?: boolean | undefined;
}

/** Select the interactive frontend. Explicit classic mode always wins. */
export function shouldUseTui(
  options: TuiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (options.classic) return false;
  if (options.tui) return true;
  if (env.CLAI_CLASSIC === "1" || env.CLAI_TUI === "0") return false;
  return true;
}
