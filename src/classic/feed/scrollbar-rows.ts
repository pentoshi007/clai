const TRACK_GLYPH = "▓";
const THUMB_GLYPH = "█";

export interface ScrollbarGeometry {
  readonly track: readonly boolean[];
}

/** One boolean per viewport row: true where the thumb occupies the track. */
export function scrollbarGeometry(
  trackRows: number,
  totalRows: number,
  offsetFromBottom: number,
): readonly boolean[] {
  const track = Math.max(0, Math.floor(trackRows));
  if (track === 0 || totalRows <= track) {
    return Array.from({ length: track }, () => false);
  }
  const thumb = Math.max(1, Math.round((track / totalRows) * track));
  const maxOffset = Math.max(1, totalRows - track);
  const scrolledTop = Math.max(0, Math.min(maxOffset, maxOffset - offsetFromBottom));
  const start = Math.round((scrolledTop / maxOffset) * (track - thumb));
  return Array.from({ length: track }, (_, index) => index >= start && index < start + thumb);
}

export function scrollbarCell(thumb: boolean): string {
  return thumb ? THUMB_GLYPH : TRACK_GLYPH;
}
