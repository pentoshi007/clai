/**
 * Renderer-independent responsive layout engine (V2-032).
 *
 * Computes the shell region rectangles from terminal dimensions and user
 * preferences following the density rules in ARCHITECTURE.md. It performs no
 * IO and reads no globals so layout can be snapshot-tested at any dimension
 * without a live terminal.
 */

export type LayoutDensity = "compact" | "single" | "wide";
export type PlanPlacement = "hidden" | "overlay" | "split";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutInput {
  readonly columns: number;
  readonly rows: number;
  /** User toggle: whether the plan pane is requested at all. */
  readonly planVisible?: boolean | undefined;
  /** User/config toggle: whether split view is permitted on wide terminals. */
  readonly splitEnabled?: boolean | undefined;
}

export interface LayoutModel {
  readonly density: LayoutDensity;
  readonly columns: number;
  readonly rows: number;
  /** Optional chrome (borders, hints, condensed status detail) survives. */
  readonly showOptionalChrome: boolean;
  readonly statusCondensed: boolean;
  readonly chat: Rect;
  readonly composer: Rect;
  readonly status: Rect;
  readonly plan: Rect & { readonly placement: PlanPlacement };
  /** Full-screen portal target for blocking overlays/pickers/modals. */
  readonly overlay: Rect;
}

// Thresholds from ARCHITECTURE.md "Responsive layout".
export const COMPACT_MAX_COLS = 79;
export const SINGLE_MAX_COLS = 119;
export const MIN_ROWS_FOR_STANDARD = 20;
export const PLAN_MIN_WIDTH = 34;
export const PLAN_MAX_WIDTH = 52;
export const CHAT_MIN_WIDTH_SPLIT = 72;
export const DIVIDER_WIDTH = 1;
export const MIN_CHAT_ROWS = 6;
export const STATUS_HEIGHT = 1;
export const COMPOSER_MAX_HEIGHT = 6;
export const COMPOSER_MIN_HEIGHT = 1;
export const COMPOSER_PREFERRED_HEIGHT = 3;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function classifyDensity(columns: number, rows: number): LayoutDensity {
  if (columns <= COMPACT_MAX_COLS || rows < MIN_ROWS_FOR_STANDARD) {
    return "compact";
  }
  if (columns <= SINGLE_MAX_COLS) return "single";
  return "wide";
}

/**
 * Vertical budget: status and composer are essential and get their rows before
 * chat. On very short terminals optional chrome is dropped and the composer
 * shrinks toward a single line so at least {@link MIN_CHAT_ROWS} chat rows
 * survive where the terminal physically allows it.
 */
function computeVertical(rows: number): {
  statusHeight: number;
  composerHeight: number;
  chatHeight: number;
  chatY: number;
  showOptionalChrome: boolean;
} {
  const usableRows = Math.max(rows, 0);
  const statusHeight = usableRows >= STATUS_HEIGHT ? STATUS_HEIGHT : 0;
  let composerHeight = COMPOSER_PREFERRED_HEIGHT;

  const roomForPreferred =
    statusHeight + COMPOSER_PREFERRED_HEIGHT + MIN_CHAT_ROWS;
  const showOptionalChrome = usableRows >= roomForPreferred;

  if (!showOptionalChrome) {
    // Shrink the composer (optional multi-line height is chrome) so chat keeps
    // its floor; never drop the composer below a single editable line.
    const nonComposer = statusHeight + MIN_CHAT_ROWS;
    composerHeight = clamp(
      usableRows - nonComposer,
      COMPOSER_MIN_HEIGHT,
      COMPOSER_PREFERRED_HEIGHT,
    );
  }

  const chatHeight = Math.max(usableRows - statusHeight - composerHeight, 0);
  return {
    statusHeight,
    composerHeight,
    chatHeight,
    chatY: statusHeight,
    showOptionalChrome,
  };
}

/**
 * Resolve where the plan pane lives. Split only engages on wide terminals when
 * the user asked for the plan, split is enabled, and both panes can keep their
 * minimum widths; otherwise the plan falls back to a floating overlay.
 */
function resolvePlan(
  columns: number,
  density: LayoutDensity,
  planVisible: boolean,
  splitEnabled: boolean,
): { placement: PlanPlacement; planWidth: number; chatWidth: number } {
  if (!planVisible) {
    return { placement: "hidden", planWidth: 0, chatWidth: columns };
  }
  if (density !== "wide" || !splitEnabled) {
    return { placement: "overlay", planWidth: 0, chatWidth: columns };
  }
  const desired = clamp(
    Math.floor(columns * 0.34),
    PLAN_MIN_WIDTH,
    PLAN_MAX_WIDTH,
  );
  const chatWidth = columns - desired - DIVIDER_WIDTH;
  if (chatWidth >= CHAT_MIN_WIDTH_SPLIT) {
    return { placement: "split", planWidth: desired, chatWidth };
  }
  // Try shrinking the plan to its floor before giving up on split.
  const shrunkPlan = columns - DIVIDER_WIDTH - CHAT_MIN_WIDTH_SPLIT;
  if (shrunkPlan >= PLAN_MIN_WIDTH) {
    return {
      placement: "split",
      planWidth: shrunkPlan,
      chatWidth: CHAT_MIN_WIDTH_SPLIT,
    };
  }
  return { placement: "overlay", planWidth: 0, chatWidth: columns };
}

export function computeLayout(input: LayoutInput): LayoutModel {
  const columns = Math.max(input.columns, 0);
  const rows = Math.max(input.rows, 0);
  const density = classifyDensity(columns, rows);
  const planVisible = input.planVisible ?? false;
  const splitEnabled = input.splitEnabled ?? false;

  const vertical = computeVertical(rows);
  const plan = resolvePlan(columns, density, planVisible, splitEnabled);

  const chat: Rect = {
    x: 0,
    y: vertical.chatY,
    width: plan.chatWidth,
    height: vertical.chatHeight,
  };

  const planRect: Rect & { placement: PlanPlacement } =
    plan.placement === "split"
      ? {
          placement: "split",
          x: plan.chatWidth + DIVIDER_WIDTH,
          y: vertical.chatY,
          width: plan.planWidth,
          height: vertical.chatHeight,
        }
      : {
          placement: plan.placement,
          x: 0,
          y: 0,
          width: 0,
          height: 0,
        };

  const composer: Rect = {
    x: 0,
    y: vertical.chatY + vertical.chatHeight,
    width: columns,
    height: vertical.composerHeight,
  };

  const status: Rect = {
    x: 0,
    y: 0,
    width: columns,
    height: vertical.statusHeight,
  };

  const overlay: Rect = { x: 0, y: 0, width: columns, height: rows };

  return {
    density,
    columns,
    rows,
    showOptionalChrome: vertical.showOptionalChrome,
    statusCondensed: density !== "wide",
    chat,
    composer,
    status,
    plan: planRect,
    overlay,
  };
}
