import type { ColorMode } from "../../app/ports/terminal-port.js";
import type { Theme } from "./theme.js";
import { renderMarkdown } from "./markdown.js";

export type AnsiLine = string;

export interface RenderMarkdownLinesOptions {
  readonly width: number;
  readonly stripOuterIndent?: boolean | undefined;
  readonly isolateBold?: boolean | undefined;
  readonly theme?: Theme | undefined;
  readonly colorMode?: ColorMode | undefined;
  readonly quotePrefix?: string | undefined;
  readonly literalQuotes?: boolean | undefined;
  readonly lineChangeColors?: boolean | undefined;
  readonly diffLines?: boolean | undefined;
  readonly copyLabel?: boolean | undefined;
}

export function renderMarkdownLines(
  text: string,
  options: RenderMarkdownLinesOptions,
): AnsiLine[] {
  if (!text) return [];
  const width = Math.max(20, options.width);
  const rendered = renderMarkdown(text, width, {
    theme: options.theme,
    colorMode: options.colorMode,
    isolateBold: options.isolateBold,
    quotePrefix: options.quotePrefix,
    literalQuotes: options.literalQuotes,
    lineChangeColors: options.lineChangeColors,
    diffLines: options.diffLines,
    copyLabel: options.copyLabel,
  }).replace(/\n+$/, "");
  if (!rendered) return [];

  return rendered.split("\n").map((line) => {
    let body = line;
    if (options.stripOuterIndent && body.startsWith("  ")) {
      body = body.slice(2);
    }
    return body.length === 0 ? " " : body;
  });
}
