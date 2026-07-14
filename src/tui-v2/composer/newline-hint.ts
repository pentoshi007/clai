/**
 * Advertises the active newline chord for the composer (COMPAT-001, V2-047).
 *
 * Shift+Enter is the primary binding but only works when the terminal can
 * report the Shift modifier on Return (`canDistinguishShiftEnter`); otherwise
 * the help/status text falls back to advertising Alt/Option+Enter, which
 * both bindings still accept.
 */

import type { TerminalCapabilityReport } from "../bootstrap/capabilities.js";

export interface NewlineHint {
  readonly chord: string;
  readonly label: string;
}

export function resolveNewlineHint(
  capabilities: Pick<TerminalCapabilityReport, "canDistinguishShiftEnter">,
): NewlineHint {
  if (capabilities.canDistinguishShiftEnter) {
    return { chord: "shift+enter", label: "Shift+Enter for newline" };
  }
  return { chord: "alt+enter", label: "Alt/Option+Enter for newline" };
}
