/**
 * Advertises the newline chord for the composer (COMPAT-001, V2-047).
 *
 * Shift+Enter is always the advertised primary (works on macOS / Linux /
 * Windows when the terminal reports the Shift modifier). Alt/Option+Enter
 * remains a bound fallback for terminals that cannot distinguish Shift+Enter.
 */

import type { TerminalCapabilityReport } from "../bootstrap/capabilities.js";

export interface NewlineHint {
  readonly chord: string;
  readonly label: string;
}

export function resolveNewlineHint(
  _capabilities: Pick<TerminalCapabilityReport, "canDistinguishShiftEnter">,
): NewlineHint {
  // Always advertise Shift+Enter — both shift and meta bindings stay active
  // in the textarea overrides so newline works across OS/terminals.
  return { chord: "shift+enter", label: "Shift+Enter newline" };
}
