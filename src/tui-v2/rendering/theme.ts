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
  /** Success / READY / allow-all green. */
  readonly success: string;
  /**
   * Wordmark top-of-"I" magenta (`WORDMARK_TOP_HEX` / chalk.magentaBright).
   * Used for plan/task pane border, agent-card frame, output accents.
   */
  readonly magenta: string;
  /** Soft cyan for command labels (legacy #67E8F9). */
  readonly cyan: string;
  readonly white: string;
  /** Assistant / model reply body (user request: green chat text). */
  readonly response: string;
  /** Amber/yellow activity text while RUNNING (legacy yellow). */
  readonly activity: string;
  /** Spinner color while RUNNING (legacy magenta). */
  readonly spinner: string;
  /** Queued badge amber-dark (legacy #854D0E). */
  readonly queued: string;
  /** Teal chip for idle command shortcuts (richer than flat slate). */
  readonly chipTeal: string;
  /** Indigo chip alternate for idle shortcuts. */
  readonly chipIndigo: string;
  /**
   * Prompt / YOU badge background — same as the CTRL+O OUTPUT chip so user
   * chrome and output chrome share one brand accent.
   */
  readonly prompt: string;
  /** Thinking / reasoning text (violet). */
  readonly thinking: string;
  /**
   * Input / composer border, ❯ mark, and cursor — electric aqua, a step
   * stronger than the `/` command menu border (`theme.border` #22D3EE).
   */
  readonly inputBorder: string;
  /** User prompt bubble border — soft magenta. */
  readonly userBorder: string;
  /** Tool output card border — blue from wordmark mid gradient. */
  readonly toolBorder: string;
  /** Modal accent border. */
  readonly modalBorder: string;
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
  success: "#166534",
  // Top of CLAI wordmark "I" (magentaBright) — plan pane + agent card frame.
  magenta: "#FF55FF",
  cyan: "#67E8F9",
  white: "#FFFFFF",
  response: "#4ADE80",
  activity: "#FACC15",
  spinner: "#E879F9",
  queued: "#854D0E",
  chipTeal: "#0E7490",
  chipIndigo: "#3730A3",
  // Match CTRL+O OUTPUT chip bg for YOU / prompt chrome.
  prompt: "#0E7490",
  thinking: "#A78BFA",
  // Stronger aqua than /command border (#22D3EE) — high-sat electric cyan.
  inputBorder: "#2EEBFF",
  userBorder: "#0E7490",
  toolBorder: "#3B82F6",
  modalBorder: "#22D3EE",
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
  success: "#166534",
  // Top of CLAI wordmark "I" (slightly deeper on light bg for contrast).
  magenta: "#D946EF",
  cyan: "#0891b2",
  white: "#FFFFFF",
  response: "#15803d",
  activity: "#a16207",
  spinner: "#a21caf",
  queued: "#854D0E",
  chipTeal: "#0e7490",
  chipIndigo: "#4338ca",
  prompt: "#0e7490",
  thinking: "#7c3aed",
  // Stronger aqua than /command border (#0891B2) for light terminals.
  inputBorder: "#06B6D4",
  userBorder: "#0e7490",
  toolBorder: "#2563eb",
  modalBorder: "#0891B2",
};

export function themeFor(hint: ThemeHint): Theme {
  return hint === "light" ? LIGHT_THEME : DARK_THEME;
}
