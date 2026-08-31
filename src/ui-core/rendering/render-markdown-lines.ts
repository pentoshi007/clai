import type { ColorMode } from "../../app/ports/terminal-port.js";
import type { Theme } from "./theme.js";
import { renderMarkdown } from "./markdown.js";

export type AnsiLine = string;

export interface RenderMarkdownLinesOptions {
  readonly width: number;
  readonly stripOuterIndent?: boolean | undefined;
  readonly theme?: Theme | undefined;
  readonly colorMode?: ColorMode | undefined;
}

export function preprocessAssistantMarkdown(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/<\/?br\s*\/?>/gi, "<br>")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<\/?p[^>]*>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n");
}

export function renderMarkdownLines(
  text: string,
  options: RenderMarkdownLinesOptions,
): AnsiLine[] {
  if (!text) return [];
  const prepared = preprocessAssistantMarkdown(text);
  const width = Math.max(20, options.width);
  const rendered = renderMarkdown(prepared, width, {
    theme: options.theme,
    colorMode: options.colorMode,
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
