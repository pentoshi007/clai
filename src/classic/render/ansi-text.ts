import { layoutWidth, stripAnsi } from "./measure.js";

const RESET = "\x1b[0m";
// biome-ignore lint: ANSI escape sequences are intentional.
const ESCAPE_START = /\x1b/;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const part of segmenter.segment(text)) out.push(part.segment);
  return out;
}

interface Token {
  readonly kind: "escape" | "text";
  readonly value: string;
}

export function tokenize(text: string): Token[] {
  if (!ESCAPE_START.test(text)) {
    return text.length > 0 ? [{ kind: "text", value: text }] : [];
  }
  const tokens: Token[] = [];
  let index = 0;
  let run = "";
  while (index < text.length) {
    if (text.charCodeAt(index) !== 0x1b) {
      run += text[index];
      index += 1;
      continue;
    }
    if (run.length > 0) {
      tokens.push({ kind: "text", value: run });
      run = "";
    }
    let end = index + 1;
    if (text[end] === "[") {
      end += 1;
      while (end < text.length && !/[A-Za-z]/.test(text[end]!)) end += 1;
      end += 1;
    } else if (text[end] === "]") {
      end += 1;
      while (end < text.length && text.charCodeAt(end) !== 0x07) end += 1;
      end += 1;
    } else {
      end += 1;
    }
    tokens.push({ kind: "escape", value: text.slice(index, Math.min(end, text.length)) });
    index = Math.min(end, text.length);
  }
  if (run.length > 0) tokens.push({ kind: "text", value: run });
  return tokens;
}

export function hasOpenStyle(text: string): boolean {
  let foreground = false;
  let background = false;
  let bold = false;
  let dim = false;
  let italic = false;
  let underline = false;
  let inverse = false;
  let hidden = false;
  let strike = false;

  for (const token of tokenize(text)) {
    if (token.kind !== "escape" || !token.value.endsWith("m")) continue;
    const body = token.value.slice(2, -1);
    const codes = body === "" ? [0] : body.split(";").map(Number);
    for (const code of codes) {
      if (!Number.isFinite(code)) continue;
      if (code === 0) {
        foreground = false;
        background = false;
        bold = false;
        dim = false;
        italic = false;
        underline = false;
        inverse = false;
        hidden = false;
        strike = false;
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 3) italic = true;
      else if (code === 4) underline = true;
      else if (code === 7) inverse = true;
      else if (code === 8) hidden = true;
      else if (code === 9) strike = true;
      else if (code === 22) {
        bold = false;
        dim = false;
      } else if (code === 23) italic = false;
      else if (code === 24) underline = false;
      else if (code === 27) inverse = false;
      else if (code === 28) hidden = false;
      else if (code === 29) strike = false;
      else if (code === 39) foreground = false;
      else if (code === 49) background = false;
      else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97) || code === 38) {
        foreground = true;
      } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107) || code === 48) {
        background = true;
      }
    }
  }

  return foreground || background || bold || dim || italic || underline || inverse || hidden || strike;
}

export function sealStyle(text: string): string {
  return hasOpenStyle(text) ? `${text}${RESET}` : text;
}

export function clipToWidth(text: string, max: number, suffix = ""): string {
  if (max <= 0) return "";
  if (layoutWidth(text) <= max) return sealStyle(text);
  const suffixWidth = layoutWidth(suffix);
  const budget = Math.max(0, max - suffixWidth);
  let out = "";
  let used = 0;
  let truncated = false;
  for (const token of tokenize(text)) {
    if (token.kind === "escape") {
      out += token.value;
      continue;
    }
    for (const grapheme of graphemes(token.value)) {
      const width = layoutWidth(grapheme);
      if (used + width > budget) {
        truncated = true;
        break;
      }
      out += grapheme;
      used += width;
    }
    if (truncated) break;
  }
  return `${sealStyle(out)}${suffix}`;
}

export function padToWidth(text: string, width: number): string {
  const deficit = width - layoutWidth(text);
  return deficit > 0 ? `${text}${" ".repeat(deficit)}` : text;
}

export function middleClipPlain(text: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (layoutWidth(text) <= max) return text;
  const marker = layoutWidth(ellipsis);
  if (max <= marker) return clipToWidth(text, max, "");
  const keep = max - marker;
  const head = Math.ceil(keep * 0.6);
  const tail = Math.floor(keep * 0.4);
  const headText = clipToWidth(text, head, "");
  let tailText = "";
  let used = 0;
  for (const grapheme of graphemes(text).reverse()) {
    const width = layoutWidth(grapheme);
    if (used + width > tail) break;
    tailText = grapheme + tailText;
    used += width;
  }
  return `${headText}${ellipsis}${tailText}`;
}

export function padStartToWidth(text: string, width: number): string {
  const deficit = width - layoutWidth(text);
  return deficit > 0 ? `${" ".repeat(deficit)}${text}` : text;
}

export function alignEnds(
  left: string,
  right: string,
  width: number,
  ellipsis: string,
): string {
  if (width <= 0) return "";
  if (right.length === 0) return clipToWidth(left, width, ellipsis);
  const rightWidth = layoutWidth(right);
  if (rightWidth + 2 > width) return clipToWidth(left, width, ellipsis);
  const leftBudget = width - rightWidth - 1;
  const clipped = clipToWidth(left, leftBudget, ellipsis);
  return `${padToWidth(clipped, leftBudget)} ${right}`;
}

export function plainText(text: string): string {
  return stripAnsi(text);
}

export function trimTrailingSpaces(text: string): string {
  const lastEscape = text.lastIndexOf("\x1b");
  if (lastEscape === -1) return text.replace(/[ \t]+$/, "");
  const tail = text.slice(lastEscape);
  const closeAt = tail.search(/[A-Za-z]/);
  if (closeAt === -1) return text;
  const head = text.slice(0, lastEscape + closeAt + 1);
  return `${head}${tail.slice(closeAt + 1).replace(/[ \t]+$/, "")}`;
}

export function joinSeparated(
  parts: readonly (string | undefined)[],
  separator: string,
): string {
  return parts.filter((part): part is string => Boolean(part)).join(separator);
}
