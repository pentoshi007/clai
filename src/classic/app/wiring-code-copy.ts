import { codeBlockCopyAt } from "../../ui-core/rendering/code-block-copy.js";
import { copyCodeBlock } from "../../ui-core/actions/copy-code-block.js";
import { plainText } from "../render/ansi-text.js";
import type { TranscriptPointerGeometry } from "../feed/transcript-selection.js";
import type { TranscriptWindow } from "../feed/transcript-window.js";
import type { MouseEvent } from "../input/key-event.js";
import type { WiringHost } from "./wiring-types.js";

const pressed = new WeakSet<WiringHost>();

export function codeBlockAtTranscriptPointer(
  window: TranscriptWindow,
  x: number,
  y: number,
  geometry: TranscriptPointerGeometry,
): string | undefined {
  const row = window.rows[y - geometry.top];
  if (!row || row.lineIndex === undefined) return undefined;
  const lines = (row.block.lines ?? []).map(plainText);
  return codeBlockCopyAt(lines, row.lineIndex, x - geometry.left);
}

export function handleCodeCopyMouse(host: WiringHost, event: MouseEvent): boolean {
  if (pressed.has(host) && (event.release || event.drag)) {
    if (event.release) pressed.delete(host);
    return true;
  }
  if (event.scroll || event.release || event.drag || event.button !== "left") return false;
  pressed.delete(host);
  if (host.panels.isOpen() || host.contextLimitEditingValue || !host.selectionWindow) return false;
  const code = codeBlockAtTranscriptPointer(host.selectionWindow, event.x, event.y, host.selectionGeometry);
  if (code === undefined) return false;
  pressed.add(host);
  host.selectionPointerCell = undefined;
  host.selectionPointerMoved = false;
  copyCodeBlock(host.services, code);
  host.schedulePaint();
  return true;
}
