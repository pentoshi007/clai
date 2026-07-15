/**
 * @deprecated Select-to-copy is re-enabled. This module is intentionally a
 * no-op kept so any stale imports fail soft. Prefer not calling it.
 *
 * Historical note: a hard prototype patch here killed all mouse selection
 * (and broke Option/drag-select). Clicks are preserved by marking interactive
 * chrome `selectable={false}` instead of disabling OpenTUI selection globally.
 */

import type { CliRenderer } from "@opentui/core";

/** No-op — OpenTUI mouse text selection is enabled. */
export function disableOpenTuiMouseTextSelection(_renderer?: CliRenderer): void {
  // intentionally empty
}
