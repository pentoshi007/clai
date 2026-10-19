import type { ColorMode } from "../../app/ports/terminal-port.js";
import { styleAnsiLine, type StyledLine } from "./styled-markdown.js";
import { renderMarkdownLines, type AnsiLine } from "../../ui-core/rendering/render-markdown-lines.js";
import { sanitizeDisplayText } from "../../ui-core/rendering/sanitize-display.js";
import { looksLikeMarkdown } from "../../ui-core/rendering/pager-source.js";
import {
  renderSubagentMarkdownLines,
  type SubagentSpanPaint,
} from "../../ui-core/rendering/subagent-presentation.js";
import type { Theme } from "../../ui-core/rendering/theme.js";

export type PagerMarkdownMode = "auto" | "force" | "plain";

export type PagerStyledLine = StyledLine;

export interface PagerDisplayLine {
  readonly plain: string;
  readonly styled?: PagerStyledLine | undefined;
}

export interface PreparePagerDisplayOptions {
  readonly body: string;
  readonly width: number;
  readonly mode?: PagerMarkdownMode | undefined;
  readonly defaultFg?: string | undefined;
  readonly theme?: Theme | undefined;
  readonly colorMode?: ColorMode | undefined;
  readonly quotePrefix?: string | undefined;
  readonly literalQuotes?: boolean | undefined;
  readonly lineChangeColors?: boolean | undefined;
  readonly diffLines?: boolean | undefined;
  readonly subagentPaint?: SubagentSpanPaint | undefined;
}

const SGR_SEQUENCE = /\x1b\[[^m]*m/g;

function lazyStyledLine(ansi: AnsiLine, defaultFg: string | undefined): PagerDisplayLine {
  return {
    plain: sanitizeDisplayText(ansi.replace(SGR_SEQUENCE, "")) || " ",
    get styled() { return styleAnsiLine(ansi, defaultFg); },
  };
}

function plainLines(body: string): PagerDisplayLine[] {
  const raw = body.replace(/\n+$/, "");
  if (!raw) return [{ plain: " " }];
  return raw.split("\n").map((line) => ({ plain: line.length === 0 ? " " : line }));
}

export function preparePagerDisplay(
  options: PreparePagerDisplayOptions,
): { readonly mode: "markdown" | "plain"; readonly lines: readonly PagerDisplayLine[] } {
  const mode = options.mode ?? "auto";
  const sanitized = sanitizeDisplayText(options.body ?? "");
  const width = Math.max(24, options.width);

  if (mode === "plain") {
    return { mode: "plain", lines: plainLines(sanitized) };
  }

  const wantMarkdown =
    mode === "force" || (mode === "auto" && looksLikeMarkdown(sanitized));

  if (!wantMarkdown) {
    return { mode: "plain", lines: plainLines(sanitized) };
  }

  try {
    const appearance = {
      width,
      defaultFg: options.defaultFg,
      stripOuterIndent: true,
      theme: options.theme,
      colorMode: options.colorMode,
      quotePrefix: options.quotePrefix,
      literalQuotes: options.literalQuotes,
      lineChangeColors: options.lineChangeColors,
      diffLines: options.diffLines,
    };
    const ansi = options.subagentPaint
      ? renderSubagentMarkdownLines(sanitized, appearance, options.subagentPaint)
      : renderMarkdownLines(sanitized, appearance);
    if (ansi.length === 0) {
      return { mode: "plain", lines: plainLines(sanitized) };
    }
    return { mode: "markdown", lines: ansi.map((line) => lazyStyledLine(line, options.defaultFg)) };
  } catch {
    return { mode: "plain", lines: plainLines(sanitized) };
  }
}
