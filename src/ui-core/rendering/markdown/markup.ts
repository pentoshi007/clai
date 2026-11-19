import { isEscapedAt, mapOutsideCodeSpans } from "./code-spans.js";

const HTML_TAG = /<\/?br\s*\/?>|<\/p>[^\S\n]*<p(?:[ \t][^>\n]*)?>|<\/?p(?:[ \t][^>\n]*)?>|<hr\s*\/?>/gi;

function expandHtmlBreaks(text: string, rule: string): string {
  if (!text.includes("<") && !text.includes("\u00a0")) return text;
  return mapOutsideCodeSpans(text, (prose) => prose
    .replace(/\u00a0/g, " ")
    .replace(HTML_TAG, (tag, offset: number, source: string) => {
      if (isEscapedAt(source, offset)) return tag;
      if (/^<hr/i.test(tag)) return rule;
      return /<\/p>[^\S\n]*<p/i.test(tag) ? "\n\n" : "\n";
    }));
}

export function splitMarkdownBreaks(line: string, rule = "\n---\n"): string[] {
  return expandHtmlBreaks(line, rule).split("\n");
}
