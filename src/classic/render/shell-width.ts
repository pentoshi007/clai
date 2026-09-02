export function horizontalPadding(columns: number): number {
  const width = Math.max(0, Math.floor(columns));
  return width >= 56 ? 2 : width >= 28 ? 1 : 0;
}

export function innerShellWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return Math.max(1, width - horizontalPadding(width) * 2);
}

export const SCROLLBAR_GUTTER_COLS = 1;

export function gutterShellWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  const pad = horizontalPadding(width);
  return Math.max(1, width - SCROLLBAR_GUTTER_COLS - pad - Math.max(0, pad - SCROLLBAR_GUTTER_COLS));
}
