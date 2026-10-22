export function horizontalPadding(columns: number): number {
  const width = Math.max(0, Math.floor(columns));
  return width >= 28 ? 1 : 0;
}

export function innerShellWidth(columns: number): number {
  const width = Math.max(1, Math.floor(columns));
  return Math.max(1, width - horizontalPadding(width) * 2);
}
