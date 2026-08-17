/**
 * CLAI theme tokens (V2-030 / QUALITY "visual correctness").
 *
 * Palette is anchored to the CLAI wordmark gradient (magenta → blue → cyan)
 * plus the legacy amber mode badge, green READY/success, and aqua chrome.
 * Components should pull from these tokens — never scatter raw hex.
 */

import type { ThemeHint } from "../bootstrap/capabilities.js";

export interface Theme {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly accent: string;
  readonly border: string;
  readonly statusBackground: string;
  /** Selected row / focus highlight (legacy #2563EB). */
  readonly selection: string;
  /** Alternating list row A (legacy #1E293B). */
  readonly rowA: string;
  /** Alternating list row B (legacy #0F172A). */
  readonly rowB: string;
  /** Chip / badge slate (legacy #334155). */
  readonly chip: string;
  /** Mode badge amber / RUNNING (legacy #B45309). */
  readonly mode: string;
  /**
   * Success / done / READY green — bright enough to read on dark panes
   * (tasks list, toasts, confirmations). Not a dim forest green.
   */
  readonly success: string;
  /**
   * Dark green plate for "done" status chips (white label on solid bg).
   * Brighter `success` is for text/borders only — too light as a fill.
   */
  readonly successBg: string;
  /**
   * Dark red plate for "failed" / "blocked" status chips (white on solid bg).
   * Brighter `diffDel` stays for text/borders.
   */
  readonly failedBg: string;
  /**
   * Wordmark top-of-"I" magenta (`WORDMARK_TOP_HEX` / chalk.magentaBright).
   * Used for plan/task pane border, agent-card frame, output accents.
   */
  readonly magenta: string;
  /** Soft cyan for command labels (legacy #67E8F9). */
  readonly cyan: string;
  readonly aqua: string;
  readonly white: string;
  /** Assistant / model reply body (user request: green chat text). */
  readonly response: string;
  /** Amber/yellow activity text while RUNNING (legacy yellow). */
  readonly activity: string;
  /**
   * Dark amber plate for "running" status chips (white label on solid bg).
   * Brighter `activity` is for text/borders only — too light as a fill.
   */
  readonly activityBg: string;
  /** Spinner color while RUNNING (legacy magenta). */
  readonly spinner: string;
  /** Queued badge amber-dark (legacy #854D0E). */
  readonly queued: string;
  /** Teal chip for idle command shortcuts (richer than flat slate). */
  readonly chipTeal: string;
  /** Indigo chip alternate for idle shortcuts. */
  readonly chipIndigo: string;
  /**
   * Prompt / YOU badge background — warm amber (matches user bubble border).
   */
  readonly prompt: string;
  /** Thinking / reasoning text (violet). */
  readonly thinking: string;
  /**
   * Input / composer border, ❯ mark, and cursor — electric aqua, a step
   * stronger than the `/` command menu border (`theme.border` #22D3EE).
   */
  readonly inputBorder: string;
  /** User prompt bubble border — warm amber. */
  readonly userBorder: string;
  /** Tool card chrome accent (legacy mid-blue). */
  readonly toolBorder: string;
  /** Tool OUTPUT body text (readable sky cyan). */
  readonly toolOutput: string;
  /** Modal accent border. */
  readonly modalBorder: string;
  /** Added lines in file-diff cards / pager (green). */
  readonly diffAdd: string;
  /** Removed lines in file-diff cards / pager (red). */
  readonly diffDel: string;
  /** Line-number gutter for diffs. */
  readonly diffGutter: string;
  /** Soft background wash for added diff lines (Cursor-style). */
  readonly diffAddBg: string;
  /** Soft background wash for removed diff lines. */
  readonly diffDelBg: string;
  /** Syntax: keyword (blue). */
  readonly synKeyword: string;
  /** Syntax: string (orange). */
  readonly synString: string;
  /** Syntax: comment. */
  readonly synComment: string;
  /** Syntax: number. */
  readonly synNumber: string;
  /** Syntax: function name. */
  readonly synFunction: string;
  /** Syntax: type / class. */
  readonly synType: string;
  /** Syntax: property / attr. */
  readonly synProperty: string;
  /** Syntax: operator. */
  readonly synOperator: string;
  /** Syntax: regex. */
  readonly synRegex: string;
}

const DARK_THEME: Theme = {
  background: "#0b0e14",
  foreground: "#F8FAFC",
  muted: "#94A3B8",
  accent: "#5cc8ff",
  border: "#22D3EE",
  statusBackground: "#11151c",
  selection: "#2563EB",
  rowA: "#1E293B",
  rowB: "#0F172A",
  chip: "#334155",
  mode: "#B45309",
  // Readable on #0b0e14 / statusBackground — was #166534 (too dark / washed).
  success: "#4ADE80",
  // Solid dark green for "done" badge fills (white text stays crisp).
  successBg: "#166534",
  // Solid dark red for "failed" badge fills.
  failedBg: "#991B1B",
  // Top of CLAI wordmark "I" (magentaBright) — plan pane + agent card frame.
  magenta: "#FF55FF",
  cyan: "#67E8F9",
  aqua: "#2EEBFF",
  white: "#FFFFFF",
  response: "#4ADE80",
  activity: "#FACC15",
  // Dark yellow/amber plate for running badges (white text stays crisp).
  activityBg: "#854D0E",
  spinner: "#E879F9",
  queued: "#854D0E",
  chipTeal: "#0E7490",
  chipIndigo: "#3730A3",
  // YOU badge plate — darker amber so white "YOU" stays crisp.
  prompt: "#B45309",
  thinking: "#A78BFA",
  // Stronger aqua than /command border (#22D3EE) — high-sat electric cyan.
  inputBorder: "#2EEBFF",
  // User prompt bubble border — lighter warm amber (distinct from YOU plate).
  userBorder: "#f5b351",
  toolBorder: "#3B82F6",
  // Tool OUTPUT body text — sky cyan (readable on dark panes).
  toolOutput: "#7DD3FC",
  modalBorder: "#22D3EE",
  diffAdd: "#4ADE80",
  diffDel: "#F87171",
  diffGutter: "#64748B",
  diffAddBg: "#12261a",
  diffDelBg: "#2a1414",
  synKeyword: "#569CD6",
  synString: "#CE9178",
  synComment: "#6A9955",
  synNumber: "#B5CEA8",
  synFunction: "#DCDCAA",
  synType: "#4EC9B0",
  synProperty: "#9CDCFE",
  synOperator: "#D4D4D4",
  synRegex: "#D16969",
};

const LIGHT_THEME: Theme = {
  background: "#fdfdfd",
  foreground: "#1c1f24",
  muted: "#6b7280",
  accent: "#0969da",
  border: "#0891B2",
  statusBackground: "#f0f2f4",
  selection: "#0969da",
  rowA: "#eef2f7",
  rowB: "#f8fafc",
  chip: "#e2e8f0",
  mode: "#B45309",
  success: "#16A34A",
  // Darker plate for "done" chips on light terminals.
  successBg: "#14532d",
  // Darker plate for "failed" chips on light terminals.
  failedBg: "#7f1d1d",
  // Top of CLAI wordmark "I" (slightly deeper on light bg for contrast).
  magenta: "#D946EF",
  cyan: "#0891b2",
  aqua: "#0891B2",
  white: "#FFFFFF",
  response: "#15803d",
  activity: "#a16207",
  // Dark amber plate for running badges on light terminals.
  activityBg: "#92400E",
  spinner: "#a21caf",
  queued: "#854D0E",
  chipTeal: "#0e7490",
  chipIndigo: "#4338ca",
  // YOU badge plate — deep amber.
  prompt: "#b45309",
  thinking: "#7c3aed",
  // Stronger aqua than /command border (#0891B2) for light terminals.
  inputBorder: "#06B6D4",
  // User prompt bubble border — lighter warm amber.
  userBorder: "#f5b351",
  toolBorder: "#2563eb",
  // Tool OUTPUT body text — sky cyan.
  toolOutput: "#0369a1",
  modalBorder: "#0891B2",
  diffAdd: "#15803d",
  diffDel: "#dc2626",
  diffGutter: "#94a3b8",
  diffAddBg: "#dcfce7",
  diffDelBg: "#fee2e2",
  synKeyword: "#0000ff",
  synString: "#a31515",
  synComment: "#008000",
  synNumber: "#098658",
  synFunction: "#795e26",
  synType: "#267f99",
  synProperty: "#001080",
  synOperator: "#000000",
  synRegex: "#811f3f",
};

export function themeFor(hint: ThemeHint): Theme {
  return hint === "light" ? LIGHT_THEME : DARK_THEME;
}
