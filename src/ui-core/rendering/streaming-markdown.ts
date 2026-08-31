
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

function fencesBalanced(text: string): boolean {
  let marker: string | undefined;
  for (const line of text.split("\n")) {
    if (marker) {
      if (isCodeFenceClose(line, marker)) marker = undefined;
      continue;
    }
    marker = matchCodeFenceOpen(line)?.marker;
  }
  return marker === undefined;
}

export interface MarkdownSplit {
  readonly stable: string;
  readonly tail: string;
}

export function stableMarkdownSplit(
  text: string,
  minStableChars = MIN_STABLE_CHARS,
): MarkdownSplit {
  if (text.length <= minStableChars) return { stable: "", tail: text };
  let search = text.length;
  for (;;) {
    const blank = text.lastIndexOf("\n\n", search - 1);
    if (blank < 0 || blank < minStableChars) return { stable: "", tail: text };
    let boundary = blank + 1;
    while (boundary < text.length && text[boundary] === "\n") boundary += 1;
    const stable = text.slice(0, boundary);
    const tail = text.slice(boundary);
    if (
      tail.length > 0 &&
      fencesBalanced(stable) &&
      !BLOCK_CONTINUATION.test(tail)
    ) {
      return { stable, tail };
    }
    search = blank;
  }
}

export interface MarkdownStreamCache {
  readonly signature: string;
  readonly stableSource: string;
  readonly stableLines: readonly AnsiLine[];
  readonly blank: AnsiLine | undefined;
}

export const EMPTY_MARKDOWN_STREAM_CACHE: MarkdownStreamCache = {
  signature: "",
  stableSource: "",
  stableLines: [],
  blank: undefined,
};

const SGR = /\x1b\[[0-9;]*m/g;

function isBlankLine(line: AnsiLine): boolean {
  return line.replace(SGR, "").trim().length === 0;
}

function trimTrailingBlanks(lines: readonly AnsiLine[]): {
  lines: readonly AnsiLine[];
  blank: AnsiLine | undefined;
} {
  let end = lines.length;
  let blank: AnsiLine | undefined;
  while (end > 0 && isBlankLine(lines[end - 1]!)) {
    blank = lines[end - 1]!;
    end -= 1;
  }
  return { lines: end === lines.length ? lines : lines.slice(0, end), blank };
}

function joinBlocks(
  head: readonly AnsiLine[],
  blank: AnsiLine | undefined,
  tail: readonly AnsiLine[],
): AnsiLine[] {
  if (head.length === 0) return [...tail];
  if (tail.length === 0) return [...head];
  return blank ? [...head, blank, ...tail] : [...head, ...tail];
}

function signatureOf(options: RenderMarkdownLinesOptions): string {
  return `${options.width}|${options.stripOuterIndent ? 1 : 0}`;
}

export interface StreamingMarkdownResult {
  readonly lines: AnsiLine[];
  readonly cache: MarkdownStreamCache;
}

export function renderStreamingMarkdown(input: {
  readonly text: string;
  readonly streaming: boolean;
  readonly options: RenderMarkdownLinesOptions;
  readonly cache: MarkdownStreamCache;
}): StreamingMarkdownResult {
  const { text, options } = input;
  if (!text) {
    return { lines: [], cache: EMPTY_MARKDOWN_STREAM_CACHE };
  }
  if (!input.streaming) {
    return {
      lines: renderMarkdownLines(text, options),
      cache: EMPTY_MARKDOWN_STREAM_CACHE,
    };
  }

  const signature = signatureOf(options);
  const split = stableMarkdownSplit(text);
  const reusable =
    input.cache.signature === signature &&
    input.cache.stableSource.length > 0 &&
    split.stable.startsWith(input.cache.stableSource);

  let stableLines: readonly AnsiLine[];
  let blank = input.cache.blank;
  if (!split.stable) {
    stableLines = [];
  } else if (reusable && split.stable === input.cache.stableSource) {
    stableLines = input.cache.stableLines;
  } else if (reusable) {
    const delta = trimTrailingBlanks(
      renderMarkdownLines(split.stable.slice(input.cache.stableSource.length), options),
    );
    blank = delta.blank ?? blank;
    stableLines = joinBlocks(input.cache.stableLines, blank, delta.lines);
  } else {
    const fresh = trimTrailingBlanks(renderMarkdownLines(split.stable, options));
    blank = fresh.blank ?? blank;
    stableLines = fresh.lines;
  }

  const tailLines = split.tail ? renderMarkdownLines(split.tail, options) : [];
  return {
    lines: joinBlocks(stableLines, blank, tailLines),
    cache: { signature, stableSource: split.stable, stableLines, blank },
  };
}
