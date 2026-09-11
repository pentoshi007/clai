export function overlaySize(columns: number, rows: number): {
  width: number;
  height: number;
  marginX: number;
  marginY: number;
} {
  const width = Math.max(1, Math.floor(columns));
  const height = Math.max(1, Math.floor(rows));
  const marginX = width >= 40 ? 2 : width >= 16 ? 1 : 0;
  const marginY = height >= 10 ? 1 : 0;
  return { width: width - marginX * 2, height: height - marginY * 2, marginX, marginY };
}
