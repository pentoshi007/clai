/** Truncate long text in the middle, keeping the start and end visible. */
export function truncateMiddle(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return "…";
  const keep = maxWidth - 1;
  const head = Math.ceil(keep * 0.6);
  const tail = Math.floor(keep * 0.4);
  return `${text.slice(0, head)}…${text.slice(Math.max(0, text.length - tail))}`;
}

export function wrapPlainString(
  text: string,
  width: number,
): { lineText: string; startIdx: number; endIdx: number }[] {
  if (text.length === 0) {
    return [{ lineText: "", startIdx: 0, endIdx: 0 }];
  }
  const lines: { lineText: string; startIdx: number; endIdx: number }[] = [];
  const paragraphs = text.split("\n");
  let currentOffset = 0;

  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p]!;
    if (para.length === 0) {
      lines.push({
        lineText: "",
        startIdx: currentOffset,
        endIdx: currentOffset,
      });
    } else {
      let idx = 0;
      while (idx < para.length) {
        let chunk = para.slice(idx, idx + width);
        let wrapLen = chunk.length;

        if (idx + width < para.length) {
          const lastSpace = chunk.lastIndexOf(" ");
          if (lastSpace > 0) {
            wrapLen = lastSpace + 1;
            chunk = para.slice(idx, idx + wrapLen);
          }
        }

        lines.push({
          lineText: chunk,
          startIdx: currentOffset + idx,
          endIdx: currentOffset + idx + wrapLen,
        });
        idx += wrapLen;
      }
    }
    currentOffset += para.length + 1;
  }
  return lines;
}

/** Compact "time ago" label for history rows, e.g. "3m", "5h", "2d". */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mon = Math.floor(day / 30);
  if (mon < 12) return `${mon}mo ago`;
  return `${Math.floor(mon / 12)}y ago`;
}

/** Last path segment of a cwd, for a short location hint in history rows. */
export function shortCwd(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
  return base || trimmed;
}
