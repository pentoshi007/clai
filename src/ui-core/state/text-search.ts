export interface TextRange {
  readonly start: number;
  readonly end: number;
}

const REGEX_SYNTAX = /[.*+?^${}()|[\]\\]/g;
const compiled = new Map<string, RegExp | undefined>();
const COMPILED_LIMIT = 32;

export function searchTerms(query: string): readonly string[] {
  return query.trim().split(/\s+/u).filter((term) => term.length > 0);
}

export function hasSearchQuery(query: string): boolean {
  return searchTerms(query).length > 0;
}

export function compileSearchQuery(query: string): RegExp | undefined {
  if (compiled.has(query)) return compiled.get(query);
  const terms = searchTerms(query);
  const pattern = terms.length === 0
    ? undefined
    : new RegExp(terms.map((term) => term.replace(REGEX_SYNTAX, "\\$&")).join("\\s+"), "giu");
  if (compiled.size >= COMPILED_LIMIT) compiled.delete(compiled.keys().next().value!);
  compiled.set(query, pattern);
  return pattern;
}

export function searchRanges(text: string, pattern: RegExp | undefined): TextRange[] {
  if (!pattern || text.length === 0) return [];
  const ranges: TextRange[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const length = match[0].length;
    if (length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    ranges.push({ start: match.index, end: match.index + length });
  }
  pattern.lastIndex = 0;
  return ranges;
}

export function findTextRanges(text: string, query: string): TextRange[] {
  return searchRanges(text, compileSearchQuery(query));
}

export function stepMatchIndex(count: number, current: number, delta: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

export function matchCounterLabel(query: string, count: number, active: number): string {
  if (!hasSearchQuery(query)) return "";
  if (count === 0) return "no matches";
  if (active < 0 || active >= count) return `${count} ${count === 1 ? "match" : "matches"}`;
  return `${active + 1}/${count}`;
}
