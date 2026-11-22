const FENCE_LINE = /^(`{3,}|~{3,})(.*)$/;

export function nextMarkdownFence(line: string, open: string | undefined): string | undefined {
  const match = FENCE_LINE.exec(line.trim());
  if (!match) return open;
  const marker = match[1]!;
  const suffix = match[2]!;
  if (open) {
    const closesFence = marker[0] === open[0] && marker.length >= open.length && !suffix;
    return closesFence ? undefined : open;
  }
  return marker[0] === "`" && suffix.includes("`") ? undefined : marker;
}
