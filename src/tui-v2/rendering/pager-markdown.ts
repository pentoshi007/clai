/**
 * Safe markdown preparation for the full-screen pager.
 *
 * - Markdown docs (help, shortcuts, plan) force-render with classic parity.
 * - Tool / log / plain bodies use a conservative heuristic so normal output
 *   is not mangled by italic underscores or stray asterisks.
 * - Any render failure falls back to plain lines (never throws into the UI).
 */

import type { ColorMode } from "../../app/ports/terminal-port.js";
import { renderStyledMarkdownLines } from "./styled-markdown.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { looksLikeMarkdown } from "../../ui-core/rendering/pager-source.js";
import type { Theme } from "../../ui-core/rendering/theme.js";

export type PagerMarkdownMode = "auto" | "force" | "plain";

/** Opaque styled line from renderMarkdownLines (avoids @opentui import here). */
export type PagerStyledLine = ReturnType<typeof renderStyledMarkdownLines>[number];

export interface PagerDisplayLine {
  /** Plain text used for search, line counts, and export fallbacks. */
  readonly plain: string;
  /**
   * Pre-styled line when markdown rendered successfully.
   * Undefined → paint as plain `plain` with baseLineFg heuristics.
   */
  readonly styled?: PagerStyledLine | undefined;
}

export interface PreparePagerDisplayOptions {
  readonly body: string;
  readonly width: number;
  readonly mode?: PagerMarkdownMode | undefined;
  /** Default body foreground when markdown renders (theme.foreground). */
  readonly defaultFg?: string | undefined;
  readonly theme?: Theme | undefined;
  readonly colorMode?: ColorMode | undefined;
}

function plainLines(body: string): PagerDisplayLine[] {
  const raw = body.replace(/\n+$/, "");
  if (!raw) return [{ plain: " " }];
  return raw.split("\n").map((line) => ({ plain: line.length === 0 ? " " : line }));
}

/**
 * Prepare body lines for the pager. Never throws.
 */
export function preparePagerDisplay(
  options: PreparePagerDisplayOptions,
): { readonly mode: "markdown" | "plain"; readonly lines: readonly PagerDisplayLine[] } {
  const mode = options.mode ?? "auto";
  const body = options.body ?? "";
  const width = Math.max(24, options.width);

  if (mode === "plain") {
    return { mode: "plain", lines: plainLines(body) };
  }

  const wantMarkdown =
    mode === "force" || (mode === "auto" && looksLikeMarkdown(body));

  if (!wantMarkdown) {
    return { mode: "plain", lines: plainLines(body) };
  }

  try {
    const styled = renderStyledMarkdownLines(body, {
      width,
      defaultFg: options.defaultFg,
      stripOuterIndent: true,
      theme: options.theme,
      colorMode: options.colorMode,
    });
    if (styled.length === 0) {
      return { mode: "plain", lines: plainLines(body) };
    }
    const lines: PagerDisplayLine[] = styled.map((st) => {
      // Join styled chunks for search/highlight. Sanitize so no CSI leaks into
      // the plain path (would blank the terminal when painting as raw text).
      const joined = st.chunks.map((c) => c.text).join("");
      const plain = sanitizeDisplayText(joined) || " ";
      return { plain, styled: st };
    });
    return { mode: "markdown", lines };
  } catch {
    // Never let a markdown bug blank the pager.
    return { mode: "plain", lines: plainLines(body) };
  }
}
