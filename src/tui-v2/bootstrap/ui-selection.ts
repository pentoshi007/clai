/**
 * Frontend selection and Phase 10 cutover policy (V2-034 / V2-100..102).
 *
 * Stages:
 * - `opt-in` (current): default remains Ink TUI; v2 only via `--ui=v2` or
 *   `CLAI_UI=v2`.
 * - `default-v2` (post dogfood): v2 is default; `--ui=legacy` / `--ui=tui` /
 *   `CLAI_UI=legacy` keep the rollback path for one release cycle.
 *
 * Flip {@link UI_CUTOVER_STAGE} only after V2-095 dogfood and matrix evidence.
 * Never remove Ink until V2-103's rollback window closes.
 */

export type UiChoice = "legacy" | "tui" | "v2";

/** Controlled cutover stage. Single switch for the default frontend. */
export type UiCutoverStage = "opt-in" | "default-v2";

/**
 * Production cutover stage. Keep at `opt-in` until interactive dogfood and
 * terminal-matrix evidence land; then set to `default-v2` for one release
 * cycle with legacy opt-out before V2-103 removes Ink.
 */
export const UI_CUTOVER_STAGE: UiCutoverStage = "opt-in";

export interface UiSelectionOptions {
  /** Value of the `--ui <choice>` flag, if provided. */
  readonly ui?: string | undefined;
  /** Legacy `--tui` / `--classic` flags, kept for back-compat. */
  readonly tui?: boolean | undefined;
  readonly classic?: boolean | undefined;
}

function normalizeUiToken(value: string | undefined): string | undefined {
  const token = value?.trim().toLowerCase();
  return token || undefined;
}

function envUiChoice(env: NodeJS.ProcessEnv): UiChoice | undefined {
  const token = normalizeUiToken(env.CLAI_UI);
  if (token === "v2") return "v2";
  if (token === "legacy" || token === "classic") return "legacy";
  if (token === "tui") return "tui";
  return undefined;
}

/**
 * True when the resolved frontend is v2 (flag, env, or default-v2 stage).
 * Explicit non-v2 flags always win over env/default.
 */
export function isV2Requested(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
  stage: UiCutoverStage = UI_CUTOVER_STAGE,
): boolean {
  return resolveUiChoice(options, env, stage) === "v2";
}

/**
 * Resolve the interactive frontend.
 *
 * Precedence: explicit `--ui` → `CLAI_UI` → `--classic`/`CLAI_CLASSIC` →
 * `--tui` → cutover-stage default.
 */
export function resolveUiChoice(
  options: UiSelectionOptions,
  env: NodeJS.ProcessEnv = process.env,
  stage: UiCutoverStage = UI_CUTOVER_STAGE,
): UiChoice {
  const flag = normalizeUiToken(options.ui);
  if (flag === "v2") return "v2";
  if (flag === "legacy" || flag === "classic") return "legacy";
  if (flag === "tui") return "tui";

  const fromEnv = envUiChoice(env);
  if (fromEnv) return fromEnv;

  if (options.classic) return "legacy";
  if (env.CLAI_CLASSIC === "1" || env.CLAI_TUI === "0") return "legacy";
  if (options.tui) return "tui";

  return stage === "default-v2" ? "v2" : "tui";
}

/** Human-readable default for doctor/help; depends on cutover stage. */
export function describeUiDefault(stage: UiCutoverStage = UI_CUTOVER_STAGE): string {
  return stage === "default-v2"
    ? "v2 (OpenTUI); use --ui=legacy or --ui=tui to opt out"
    : "tui (Ink); use --ui=v2 or CLAI_UI=v2 to opt in";
}
