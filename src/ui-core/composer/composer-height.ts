
export function countComposerVisualLines(text: string, wrapWidth: number, maxRows = Infinity): number {
  if (!text) return 1;
  const width = Math.max(1, wrapWidth);
  let rows = 0;
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline < 0 ? text.length : newline;
    if (start === end) rows += 1;
    while (start < end) {
      let length = Math.min(width, end - start);
      if (start + width < end) {
        const space = text.slice(start, start + width).lastIndexOf(" ");
        if (space > 0) length = space + 1;
      }
      rows += 1;
      if (rows >= maxRows) return rows;
      start += length;
    }
    if (rows >= maxRows || newline < 0) break;
    start = newline + 1;
  }
  return Math.max(1, rows);
}

export function resolveComposerTextRows(
  contentLines: number,
  maxRows: number,
  minRows = 1,
): number {
  const min = Math.max(1, minRows);
  const max = Math.max(min, maxRows);
  return Math.min(max, Math.max(min, Math.max(1, contentLines)));
}

export function maxComposerTextRows(opts: {
  readonly terminalRows: number;
  readonly statusHeight: number;
  readonly minChatRows: number;
  readonly maxCap: number;
  readonly borderRows?: number;
}): number {
  const borders = opts.borderRows ?? 2;
  const budget =
    opts.terminalRows - opts.statusHeight - opts.minChatRows - borders;
  return Math.max(1, Math.min(opts.maxCap, budget));
}
