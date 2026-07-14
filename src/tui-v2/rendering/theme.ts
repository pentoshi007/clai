/**
 * Single theme-token module (V2-030 groundwork, QUALITY "visual correctness").
 *
 * Components read colors from here rather than scattering raw hex values, so a
 * light/high-contrast/NO_COLOR variant can be swapped in one place. Kept
 * intentionally small for the empty Phase 3 shell; it grows with the transcript
 * and picker surfaces in later phases.
 */

import type { ThemeHint } from "../bootstrap/capabilities.js";

export interface Theme {
  readonly background: string;
  readonly foreground: string;
  readonly muted: string;
  readonly accent: string;
  readonly border: string;
  readonly statusBackground: string;
}

const DARK_THEME: Theme = {
  background: "#0b0e14",
  foreground: "#e6e6e6",
  muted: "#8a8f98",
  accent: "#5cc8ff",
  border: "#2a2f3a",
  statusBackground: "#11151c",
};

const LIGHT_THEME: Theme = {
  background: "#fdfdfd",
  foreground: "#1c1f24",
  muted: "#6b7280",
  accent: "#0969da",
  border: "#d0d7de",
  statusBackground: "#f0f2f4",
};

export function themeFor(hint: ThemeHint): Theme {
  return hint === "light" ? LIGHT_THEME : DARK_THEME;
}
