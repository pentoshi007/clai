/**
 * Classic-parity markdown for OpenTUI transcript rows.
 *
 * OpenTUI's native `<markdown>` component does not expand `<br>`, and its
 * table styling diverges from classic clai. We reuse `renderMarkdown` from
 * `ui/markdown.ts` (tables, fences, lists, `<br>`, …) and convert the ANSI
 * output into OpenTUI `StyledText` chunks.
 */

import { renderMarkdown } from "../../ui/markdown.js";
import { ansiToStyledText } from "./ansi-to-styled.js";

type StyledLine = ReturnType<typeof ansiToStyledText>;

export interface RenderMarkdownLinesOptions {
  /** Wrap budget in columns (classic uses terminal width − chrome). */
  readonly width: number;
  /** Default body color (assistant replies use theme.response green). */
  readonly defaultFg?: string | undefined;
  /**
   * `renderMarkdown` prefixes every line with two spaces; strip them when the
   * caller already pads the container (assistant box uses paddingLeft: 2).
   */
  readonly stripOuterIndent?: boolean | undefined;
}

/**
 * Pre-normalize a few HTML-ish tokens models emit so classic markdown sees
 * clean source (beyond the `<br>` expansion it already does).
 */
export function preprocessAssistantMarkdown(text: string): string {
  return text
    // Non-breaking spaces → regular space so wrap math stays sane.
    .replace(/\u00a0/g, " ")
    // Common self-closing / HTML line breaks that slip past some model paths.
    .replace(/<\/?br\s*\/?>/gi, "<br>")
    // Paragraph breaks occasionally emitted as HTML.
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<\/?p[^>]*>/gi, "\n")
    // Horizontal rules as HTML.
    .replace(/<hr\s*\/?>/gi, "\n---\n");
}

/** Render markdown into one StyledText line per physical row. */
export function renderMarkdownLines(
  text: string,
  options: RenderMarkdownLinesOptions,
): StyledLine[] {
  if (!text) return [];
  const prepared = preprocessAssistantMarkdown(text);
  const width = Math.max(20, options.width);
  const rendered = renderMarkdown(prepared, width).replace(/\n+$/, "");
  if (!rendered) return [];

  return rendered.split("\n").map((line) => {
    let body = line;
    if (options.stripOuterIndent && body.startsWith("  ")) {
      body = body.slice(2);
    }
    return ansiToStyledText(body.length === 0 ? " " : body, {
      defaultFg: options.defaultFg,
    });
  });
}
