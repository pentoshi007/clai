/**
 * Pure URL/file-path span detector (SEL/CHAT "clickable links/file paths").
 *
 * Renderer-independent so components decorate text without each one
 * reimplementing the regexes, and so the detection rules are unit-testable
 * without mounting a terminal.
 */

export type LinkKind = "url" | "path";

export interface LinkSpan {
  readonly kind: LinkKind;
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/g;
// Heuristic: a `~/`, `./`, `../`, or absolute `/` prefix, path segments, and a
// final segment with an extension; optional `:line[:col]` for editor jumps.
const PATH_RE = /(?:~\/|\.{1,2}\/|\/)[\w.\-/]*[\w-]+\.\w+(?::\d+(?::\d+)?)?/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]'"]+$/;

function trimTrailing(value: string): string {
  return value.replace(TRAILING_PUNCTUATION, "");
}

function overlaps(spans: readonly LinkSpan[], start: number, end: number): boolean {
  return spans.some((s) => start < s.end && end > s.start);
}

/** Detects URLs first, then file paths in the remaining, non-overlapping text. */
export function detectLinks(text: string): LinkSpan[] {
  const spans: LinkSpan[] = [];

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const trimmed = trimTrailing(raw);
    if (!trimmed) continue;
    spans.push({ kind: "url", start, end: start + trimmed.length, value: trimmed });
  }

  for (const match of text.matchAll(PATH_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const trimmed = trimTrailing(raw);
    if (!trimmed) continue;
    const end = start + trimmed.length;
    if (overlaps(spans, start, end)) continue;
    spans.push({ kind: "path", start, end, value: trimmed });
  }

  return spans.sort((a, b) => a.start - b.start);
}
