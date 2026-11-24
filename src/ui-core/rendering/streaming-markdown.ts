import chalk from "chalk";
import {
  isCodeFenceClose,
  matchCodeFenceOpen,
} from "./code-block.js";
import {
  renderMarkdownLines,
  type AnsiLine,
  type RenderMarkdownLinesOptions,
} from "./render-markdown-lines.js";

const BLOCK_CONTINUATION = /^(?:[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|\||>)|[ \t]{4,}\S)/;

const MIN_STABLE_CHARS = 512;

export interface MarkdownSplit {
  readonly stable: string;
  readonly tail: string;
}

export function stableMarkdownSplit(
  text: string,
  minStableChars = MIN_STABLE_CHARS,
): MarkdownSplit {
  if (text.length <= minStableChars) return { stable: "", tail: text };
  let boundary = 0;
  let blankStart: number | undefined;
  let fence: string | undefined;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end).replace(/\r$/, "");
    if (fence) {
      if (isCodeFenceClose(line, fence)) fence = undefined;
    } else if (!line.trim()) {
      blankStart ??= start;
    } else {
      if (blankStart !== undefined && blankStart >= minStableChars && !BLOCK_CONTINUATION.test(line)) {
        boundary = start;
      }
      blankStart = undefined;
      fence = matchCodeFenceOpen(line)?.marker;
    }
    start = end + 1;
  }
  return { stable: text.slice(0, boundary), tail: text.slice(boundary) };
}

export interface MarkdownStreamCache<T = AnsiLine> {
  readonly signature: string;
  readonly stableSource: string;
  readonly stableLines: readonly T[];
}

export const EMPTY_MARKDOWN_STREAM_CACHE: MarkdownStreamCache<never> = {
  signature: "",
  stableSource: "",
  stableLines: [],
};

const THEME_SIGNATURES = new WeakMap<
  NonNullable<RenderMarkdownLinesOptions["theme"]>,
  number
>();
let nextThemeSignature = 1;

function themeSignature(
  theme: RenderMarkdownLinesOptions["theme"],
): number {
  if (!theme) return 0;
  const cached = THEME_SIGNATURES.get(theme);
  if (cached !== undefined) return cached;
  const signature = nextThemeSignature;
  nextThemeSignature += 1;
  THEME_SIGNATURES.set(theme, signature);
  return signature;
}

function signatureOf(options: RenderMarkdownLinesOptions): string {
  return JSON.stringify([
    options.width,
    options.stripOuterIndent,
    options.isolateBold,
    options.colorMode ?? chalk.level,
    themeSignature(options.theme),
    options.quotePrefix,
    options.literalQuotes,
    options.lineChangeColors,
    options.copyLabel,
  ]);
}

export interface StreamingMarkdownResult<T = AnsiLine> {
  readonly lines: T[];
  readonly cache: MarkdownStreamCache<T>;
}

interface MarkdownStreamInput<T> {
  readonly text: string;
  readonly streaming: boolean;
  readonly options: RenderMarkdownLinesOptions;
  readonly cache: MarkdownStreamCache<T>;
}

export function renderStreamingMarkdown(input: MarkdownStreamInput<AnsiLine>): StreamingMarkdownResult {
  return renderMarkdownStream(input, text => renderMarkdownLines(text, input.options));
}

export function renderMarkdownStream<T>(input: MarkdownStreamInput<T>, render: (text: string) => T[]): StreamingMarkdownResult<T> {
  const { text, options } = input;
  if (!text) {
    return { lines: [], cache: EMPTY_MARKDOWN_STREAM_CACHE };
  }
  if (!input.streaming || options.diffLines) {
    return {
      lines: render(text),
      cache: EMPTY_MARKDOWN_STREAM_CACHE,
    };
  }

  const signature = signatureOf(options);
  const split = stableMarkdownSplit(text);
  const reusable =
    input.cache.signature === signature &&
    input.cache.stableSource.length > 0 &&
    split.stable.startsWith(input.cache.stableSource);

  const previousSource = reusable ? input.cache.stableSource : "";
  const previousLines = reusable ? input.cache.stableLines : [];
  const newSource = split.stable.slice(previousSource.length);
  const stableLines = newSource
    ? [...previousLines, ...render(newSource).slice(0, -1)]
    : previousLines;

  const tailLines = split.tail ? render(split.tail) : [];
  return {
    lines: [...stableLines, ...tailLines],
    cache: { signature, stableSource: split.stable, stableLines },
  };
}
