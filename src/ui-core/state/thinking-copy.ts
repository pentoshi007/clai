/**
 * Copy the reasoning of the focused thinking card (`c` in the transcript).
 *
 * Renderer-neutral so both surfaces can share it and so the outcome is
 * testable without a clipboard or a live renderer. The card's body is a paged
 * window, so this deliberately copies the item's whole content rather than
 * whatever rows happen to be on screen.
 */

import type { ClipboardPort } from "../../app/ports/clipboard-port.js";
import type { TranscriptState } from "./transcript-types.js";

export type ThinkingCopyResult = "copied" | "empty" | "none" | "failed";

export function focusedThinkingContent(
  state: TranscriptState,
): string | undefined {
  const id = state.focusedThinkingId;
  if (id === undefined) return undefined;
  const item = state.byId.get(id);
  if (item?.kind !== "thinking") return undefined;
  return item.content;
}

export async function copyFocusedThinking(
  state: TranscriptState,
  clipboard: ClipboardPort,
): Promise<ThinkingCopyResult> {
  const content = focusedThinkingContent(state);
  if (content === undefined) return "none";
  const text = content.replace(/\r\n/g, "\n").trimEnd();
  if (text.trim().length === 0) return "empty";
  try {
    await clipboard.writeText(text);
    return "copied";
  } catch {
    return "failed";
  }
}
