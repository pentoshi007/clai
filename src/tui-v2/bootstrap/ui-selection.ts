/**
 * Frontend selection for the v2 renderer (V2-034).
 *
 * v2 stays strictly opt-in until the controlled cutover phase: it is chosen
 * only by an explicit `--ui=v2` flag or `CLAI_UI=v2`, never by default. The
 * legacy line REPL and the existing Ink TUI remain the defaults. Resolution is
 * pure so the CLI wiring can be unit-tested without a terminal.
 */

export type UiChoice = "legacy" | "tui" | "v2";

export interface UiSelectionOptions {
  /** Value of the `--ui <choice>` flag, if provided. */
  readonly ui?: string | undefined;
  /** Legacy `--tui` / `--classic` flags, kept for back-compat. */
  readonly tui?: boolean | undefined;
  readonly classic?: boolean | undefined;
}

export function isV2Requested(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flag = options.ui?.trim().toLowerCase();
  if (flag === "v2") return true;
  if (flag === "legacy" || flag === "tui" || flag === "classic") return false;
  return env.CLAI_UI?.trim().toLowerCase() === "v2";
}

/**
 * Resolve the frontend. Explicit `--ui` wins; then `CLAI_UI=v2`; otherwise the
 * decision defers to the existing legacy/tui selection (v2 never becomes the
 * default here).
 */
export function resolveUiChoice(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
): UiChoice {
  const flag = options.ui?.trim().toLowerCase();
  if (flag === "v2") return "v2";
  if (flag === "legacy" || flag === "classic") return "legacy";
  if (flag === "tui") return "tui";
  if (env.CLAI_UI?.trim().toLowerCase() === "v2") return "v2";
  if (options.classic) return "legacy";
  return "tui";
}
