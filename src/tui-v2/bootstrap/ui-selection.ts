/**
 * Interactive frontend selection for clai 3.x.
 *
 * Default: OpenTUI full-screen TUI.
 * Opt-out: classic line REPL via `--classic`, `--ui=legacy`, or CLAI_CLASSIC=1.
 *
 * `--ui=tui` / `--ui=v2` / CLAI_UI=tui|v2 all resolve to the OpenTUI TUI
 * (aliases kept so old scripts keep working after the Ink removal).
 */

export type UiChoice = "legacy" | "tui";

export interface UiSelectionOptions {
  /** Value of the `--ui <choice>` flag, if provided. */
  readonly ui?: string | undefined;
  /** `--tui` / `--classic` flags (back-compat). */
  readonly tui?: boolean | undefined;
  readonly classic?: boolean | undefined;
}

function normalizeUiToken(value: string | undefined): string | undefined {
  const token = value?.trim().toLowerCase();
  return token || undefined;
}

function envUiChoice(env: NodeJS.ProcessEnv): UiChoice | undefined {
  const token = normalizeUiToken(env.CLAI_UI);
  if (token === "legacy" || token === "classic") return "legacy";
  // tui | v2 | opentui → full-screen TUI
  if (token === "tui" || token === "v2" || token === "opentui") return "tui";
  return undefined;
}

/** True when the resolved frontend is the full-screen OpenTUI. */
export function isTuiRequested(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return resolveUiChoice(options, env) === "tui";
}

/** @deprecated Use {@link isTuiRequested}. Kept for older call sites. */
export function isV2Requested(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isTuiRequested(options, env);
}

/**
 * Resolve the interactive frontend.
 *
 * Precedence: explicit `--ui` → `CLAI_UI` → `--classic`/`CLAI_CLASSIC` →
 * `--tui` → default TUI.
 */
export function resolveUiChoice(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
): UiChoice {
  const flag = normalizeUiToken(options.ui);
  if (flag === "legacy" || flag === "classic") return "legacy";
  if (flag === "tui" || flag === "v2" || flag === "opentui") return "tui";

  const fromEnv = envUiChoice(env);
  if (fromEnv) return fromEnv;

  if (options.classic) return "legacy";
  if (env.CLAI_CLASSIC === "1" || env.CLAI_TUI === "0") return "legacy";
  // --tui is a no-op affirmation of the default
  if (options.tui) return "tui";

  return "tui";
}

/** Human-readable default for doctor/help. */
export function describeUiDefault(): string {
  return "tui (OpenTUI); use --classic or --ui=legacy for line REPL";
}
