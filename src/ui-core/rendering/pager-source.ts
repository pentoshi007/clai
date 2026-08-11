/**
 * Strip file-diff / modal line gutters (`  12 │ ` / `     │ ± `) so format
 * mode can render real markdown instead of gutter-polluted source.
 * Leaves non-guttered lines unchanged (help, compact cards, tool dumps).
 * For fs.read `N: ` prefixes use {@link extractFsReadFileBody} instead.
 */
export function stripPagerLineGutters(body: string): string {
  if (!body) return body;
  return body
    .split("\n")
    .map((line) => {
      // formatModalPlainText writes blank rows as a bare gutter (`     │`,
      // no trailing space). Without this the pipe survives into format mode
      // and paints as a stray vertical bar under the header.
      if (/^[\d ]{0,8} │\s*$/.test(line)) return "";
      // formatModalPlainText: `<lineno> │ [+/-/ ]body`
      const withMark = /^(?:[\d ]{0,8}) │ ([+\-−] )?(.*)$/.exec(line);
      if (withMark) {
        // Diff marks stay only in raw view; format wants pure file text.
        return withMark[2] ?? "";
      }
      return line;
    })
    .join("\n");
}

/**
 * Extract clean markdown source from an fs.read tool dump for formatted
 * preview (chat card + pager). Strips:
 *  - `# fs.read path=…` / `# hasMore=…` chrome headers/footers
 *  - `N: ` line-number prefixes the tool adds for model navigation
 *  - optional `Tool fs.read result (…):` wrappers
 */
export function extractFsReadFileBody(raw: string): string {
  if (!raw) return "";
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const body: string[] = [];
  for (const line of lines) {
    // Tool / receipt chrome
    if (/^(ok|failed)$/i.test(line.trim())) continue;
    if (/^Tool\s+\S+\s+result\s*\(/i.test(line)) continue;
    if (/^full output saved to /i.test(line)) continue;
    if (/^artifact: /i.test(line)) continue;
    // fs.read meta headers (not markdown ATX titles)
    if (/^#\s*fs\.read\b/i.test(line)) continue;
    if (/^#\s*hasMore=/i.test(line)) continue;
    if (/^#\s*next:/i.test(line)) continue;
    if (/^#\s*file is empty\b/i.test(line)) continue;
    if (/^#\s*requested lines\b/i.test(line)) continue;
    if (/^#\s*path=/i.test(line)) continue;
    // Numbered content: `12: ## Heading` → `## Heading`
    const num = /^(\d+):\s?(.*)$/.exec(line);
    if (num) {
      body.push(num[2] ?? "");
      continue;
    }
    body.push(line);
  }
  return body.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

/**
 * Conservative detector: only claim "markdown" when structure is clear.
 * Avoids mangling paths_with_underscores and shell output with * globs.
 */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 8) return false;
  let score = 0;
  if (/^#{1,6}\s+\S/m.test(text)) score += 2;
  if (/^```[\w-]*\s*$/m.test(text)) score += 2;
  if (/^\|.+\|/m.test(text) && /^\|?[\s:|-]{3,}/m.test(text)) score += 2;
  if (/^>\s+\S/m.test(text)) score += 1;
  // Multiple bold spans or list items separated by blank lines
  const bold = text.match(/\*\*[^*\n]{1,80}\*\*/g);
  if (bold && bold.length >= 2) score += 1;
  if (/^[-*]\s+\S.+\n\n/m.test(text) || /^\d+\.\s+\S.+\n\n/m.test(text)) {
    score += 1;
  }
  // Explicit horizontal rules common in our docs
  if (/^---+\s*$/m.test(text) || /^\*\*\*+\s*$/m.test(text)) score += 1;
  return score >= 2;
}
