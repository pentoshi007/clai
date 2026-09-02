export function stripPagerLineGutters(body: string): string {
  if (!body) return body;
  return body
    .split("\n")
    .map((line) => {
      if (/^[\d ]{0,8} │\s*$/.test(line)) return "";
      const withMark = /^(?:[\d ]{0,8}) │ ([+\-−] )?(.*)$/.exec(line);
      if (withMark) {
        return withMark[2] ?? "";
      }
      return line;
    })
    .join("\n");
}

export function extractFsReadFileBody(raw: string): string {
  if (!raw) return "";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const body: string[] = [];
  for (const line of lines) {
    if (/^(ok|failed)$/i.test(line.trim())) continue;
    if (/^Tool\s+\S+\s+result\s*\(/i.test(line)) continue;
    if (/^full output saved to /i.test(line)) continue;
    if (/^artifact: /i.test(line)) continue;
    if (/^#\s*fs\.read\b/i.test(line)) continue;
    if (/^#\s*hasMore=/i.test(line)) continue;
    if (/^#\s*next:/i.test(line)) continue;
    if (/^#\s*file is empty\b/i.test(line)) continue;
    if (/^#\s*requested lines\b/i.test(line)) continue;
    if (/^#\s*path=/i.test(line)) continue;
    const num = /^(\d+):\s?(.*)$/.exec(line);
    if (num) {
      body.push(num[2] ?? "");
      continue;
    }
    body.push(line);
  }
  return body.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 8) return false;
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(text)) score += 2;
  if (/^```[\w-]*\s*$/m.test(text)) score += 2;
  if (/^\|.+\|/m.test(text) && /^\|?[\s:|-]{3,}/m.test(text)) score += 2;
  if (/^>\s+\S/m.test(text)) score += 1;
  const bold = text.match(/\*\*[^*\n]{1,80}\*\*/g);
  if (bold && bold.length >= 2) score += 1;
  if (/^[-*]\s+\S.+\n\n/m.test(text) || /^\d+\.\s+\S.+\n\n/m.test(text)) {
    score += 1;
  }
  if (/^---+\s*$/m.test(text) || /^\*\*\*+\s*$/m.test(text)) score += 1;
  return score >= 2;
}
