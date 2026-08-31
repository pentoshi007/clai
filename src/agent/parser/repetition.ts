

/** Lines where repetition is meaningful syntax/content and must stay byte-exact. */
function isRepetitionSensitiveMarkdownLine(line: string): boolean {
  if (/^(?: {4}|\t)/.test(line)) return true;
  if (line.includes("`")) return true;
  if ((line.match(/\|/g)?.length ?? 0) >= 2) return true;
  if (/!?\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/.test(line)) return true;
  if (/^\s{0,3}(?:#{1,6}(?:\s|$)|>\s?|[-+*]\s+|\d+[.)]\s+)/.test(line)) {
    return true;
  }
  return /^\s{0,3}(?:(?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,}|=+)\s*$/.test(
    line,
  );
}

function collapseRepeatedProse(text: string): string {
  return text.replace(
    /(.{3,80}?)\1{6,}/gs,
    (match: string, unit: string) => {
      // Punctuation runs are commonly Markdown separators/rules even when a
      // caller gives us an incomplete fragment without its surrounding line.
      if (!/[\p{L}\p{N}]/u.test(unit)) return match;
      return `${unit.repeat(3)} …[repeated ~${Math.round(
        match.length / Math.max(1, unit.length),
      )}× — collapsed]`;
    },
  );
}

/**
 * Collapse pathological repetition before a message is stored in history.
 * Some models degenerate into emitting the same short phrase hundreds of
 * times ("We need to wait.We need to wait.…"), which otherwise bloats the
 * context window and wastes tokens on every subsequent turn. We keep a few
 * copies and note the collapse so the meaning is preserved without the bulk.
 *
 * Markdown tables, rules, lists, links, and code must remain exact: this runs
 * before Markdown parsing, so changing one delimiter makes the renderer fall
 * back to raw pipes. Plain prose spans can still include repeated newlines and
 * therefore retain the original protection against multi-line degeneration.
 */
export function collapseRepeatedText(text: string): string {
  if (!text || text.length < 1500) return text;
  try {
    const pieces = text.split(/(\r\n|\n|\r)/);
    let output = "";
    let prose = "";
    let fence: { marker: string; length: number } | undefined;

    const flushProse = (): void => {
      if (!prose) return;
      output += collapseRepeatedProse(prose);
      prose = "";
    };

    for (let index = 0; index < pieces.length; index += 2) {
      const line = pieces[index] ?? "";
      const newline = pieces[index + 1] ?? "";
      const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      const protectedLine =
        fence !== undefined ||
        fenceMatch !== null ||
        isRepetitionSensitiveMarkdownLine(line);

      if (protectedLine) {
        flushProse();
        output += line + newline;
      } else {
        prose += line + newline;
      }

      if (fenceMatch) {
        const token = fenceMatch[1]!;
        if (!fence) {
          fence = { marker: token[0]!, length: token.length };
        } else {
          const rest = line.slice(fenceMatch[0].length);
          if (
            token[0] === fence.marker &&
            token.length >= fence.length &&
            rest.trim() === ""
          ) {
            fence = undefined;
          }
        }
      }
    }

    flushProse();
    return output;
  } catch {
    return text;
  }
}
