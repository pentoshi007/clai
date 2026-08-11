/** Horizontal shell geometry shared by every classic surface. */
export function horizontalPadding(columns: number): number {
  const width = Math.max(0, Math.floor(columns));
  return width >= 56 ? 2 : width >= 28 ? 1 : 0;
}

/** Width available between the shell's left and right terminal margins. */
export function innerShellWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return Math.max(1, width - horizontalPadding(width) * 2);
}

/** Columns reserved at the right screen edge for the scrollbar gutter. */
export const SCROLLBAR_GUTTER_COLS = 1;

/**
 * Content width with the scrollbar gutter parked in the right shell margin:
 * the gutter takes one column of the right padding (or one content column on
 * narrow screens), leaving a gap between the content and the track.
 */
export function gutterShellWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  const pad = horizontalPadding(width);
  return Math.max(1, width - SCROLLBAR_GUTTER_COLS - pad - Math.max(0, pad - SCROLLBAR_GUTTER_COLS));
}
