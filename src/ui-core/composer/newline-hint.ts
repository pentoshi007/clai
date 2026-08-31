
import type { TerminalCapabilityReport } from "../../ui-core/bootstrap/capabilities.js";

export interface NewlineHint {
  readonly chord: string;
  readonly label: string;
}

export function resolveNewlineHint(
  _capabilities: Pick<TerminalCapabilityReport, "canDistinguishShiftEnter">,
): NewlineHint {
  return { chord: "shift+enter", label: "Shift+Enter newline" };
}
