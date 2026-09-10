import type { StyledText } from "@opentui/core";
import {
  renderMarkdownLines,
  type AnsiLine,
  type RenderMarkdownLinesOptions,
} from "../../ui-core/rendering/render-markdown-lines.js";
import {
  renderStreamingMarkdown,
  type MarkdownStreamCache,
} from "../../ui-core/rendering/streaming-markdown.js";
import { ansiToStyledText } from "./ansi-to-styled.js";
import { RenderCache } from "../../ui-core/rendering/render-cache.js";

export type StyledLine = StyledText;

export interface StyledMarkdownOptions extends RenderMarkdownLinesOptions {
  readonly defaultFg?: string | undefined;
}

const styledCache = new RenderCache<StyledText>(4096, 8 * 1024 * 1024);

export function styleAnsiLine(line: AnsiLine, defaultFg: string | undefined): StyledText {
  const key = `${defaultFg ?? ""}\u0000${line}`;
  const hit = styledCache.get(key);
  if (hit) return hit;
  const styled = ansiToStyledText(line, { defaultFg });
  const weight = styled.chunks.reduce(
    (total, chunk) => total + chunk.text.length * 2 + 256,
    64,
  );
  styledCache.set(key, styled, weight);
  return styled;
}

export function styleAnsiLines(
  lines: readonly AnsiLine[],
  defaultFg: string | undefined,
): StyledText[] {
  return lines.map((line) => styleAnsiLine(line, defaultFg));
}

export function renderStyledMarkdownLines(
  text: string,
  options: StyledMarkdownOptions,
): StyledText[] {
  return styleAnsiLines(renderMarkdownLines(text, options), options.defaultFg);
}

export interface StyledStreamingMarkdownResult {
  readonly lines: StyledText[];
  readonly cache: MarkdownStreamCache;
}

export function renderStyledStreamingMarkdown(input: {
  readonly text: string;
  readonly streaming: boolean;
  readonly options: StyledMarkdownOptions;
  readonly cache: MarkdownStreamCache;
}): StyledStreamingMarkdownResult {
  const result = renderStreamingMarkdown({
    text: input.text,
    streaming: input.streaming,
    options: input.options,
    cache: input.cache,
  });
  return {
    lines: styleAnsiLines(result.lines, input.options.defaultFg),
    cache: result.cache,
  };
}
