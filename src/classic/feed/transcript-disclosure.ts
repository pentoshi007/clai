import type { TranscriptPointerGeometry } from "./transcript-selection.js";
import type { TranscriptWindow } from "./transcript-window.js";

export function disclosureAtPointer(
  window: TranscriptWindow,
  x: number,
  y: number,
  geometry: TranscriptPointerGeometry,
): { readonly itemId: string; readonly action: "output" | undefined } | undefined {
  const row = window.rows[y - geometry.top];
  if (!row || row.lineIndex === undefined) return undefined;
  const column = x - geometry.left;
  const target = row.block.disclosures?.find((entry) => entry.lineIndex === row.lineIndex && column >= entry.column && column < entry.column + entry.width);
  return target ? { itemId: row.block.itemId, action: target.action } : undefined;
}
