

export type SyntaxKind =
  | "plain"
  | "keyword"
  | "string"
  | "comment"
  | "number"
  | "function"
  | "type"
  | "operator"
  | "punctuation"
  | "property"
  | "regex";

export interface SyntaxSpan {
  readonly kind: SyntaxKind;
  readonly text: string;
}

export interface HighlightCarry {
  inBlockComment: boolean;
  /** For languages with nested or multi-line strings (python triple-quote). */
  inTripleString: boolean;
  tripleQuote?: string | undefined;
}

export function push(spans: SyntaxSpan[], kind: SyntaxKind, text: string): void {
  if (!text) return;
  const last = spans[spans.length - 1];
  if (last && last.kind === kind) {
    spans[spans.length - 1] = { kind, text: last.text + text };
  } else {
    spans.push({ kind, text });
  }
}

export function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$\u00a0-\uffff]/.test(ch);
}

export function isIdentCont(ch: string): boolean {
  return /[A-Za-z0-9_$\u00a0-\uffff]/.test(ch);
}

interface ClikeOpts {
  regex?: boolean;
  hashNumber?: boolean;
  lineComment?: string; // default //
  caseInsensitiveKeywords?: boolean;
}

export function highlightClike(
  line: string,
  keys: Set<string>,
  carry: HighlightCarry,
  opts: ClikeOpts = {},
): SyntaxSpan[] {
  const spans: SyntaxSpan[] = [];
  const n = line.length;
  let i = 0;
  const lineComment = opts.lineComment ?? "//";

  while (i < n) {
    if (carry.inBlockComment) {
      const end = line.indexOf("*/", i);
      if (end < 0) {
        push(spans, "comment", line.slice(i));
        return spans;
      }
      push(spans, "comment", line.slice(i, end + 2));
      carry.inBlockComment = false;
      i = end + 2;
      continue;
    }

    const ch = line[i]!;
    const next = line[i + 1];

    // line comment
    if (line.startsWith(lineComment, i)) {
      push(spans, "comment", line.slice(i));
      return spans;
    }
    // block comment
    if (ch === "/" && next === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        push(spans, "comment", line.slice(i));
        carry.inBlockComment = true;
        return spans;
      }
      push(spans, "comment", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }

    // strings
    if (ch === '"' || ch === "'" || ch === "`") {
      i = readString(line, i, ch, spans);
      continue;
    }

    // regex
    if (opts.regex && ch === "/" && next && next !== "/" && next !== "*") {
      const prev = spans.length ? spans[spans.length - 1]!.text.trimEnd().slice(-1) : "";
      if (!prev || /[=(:,[\!&|?{;]/.test(prev)) {
        const j = readRegex(line, i);
        if (j > i) {
          push(spans, "regex", line.slice(i, j));
          i = j;
          continue;
        }
      }
    }

    // #hex colors in css
    if (opts.hashNumber && ch === "#" && next && /[0-9a-fA-F]/.test(next)) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-F]/.test(line[j]!)) j += 1;
      push(spans, "number", line.slice(i, j));
      i = j;
      continue;
    }

    // numbers
    if (/\d/.test(ch) || (ch === "." && next && /\d/.test(next))) {
      let j = i;
      while (j < n && /[\d._xXa-fA-FeEpP+-]/.test(line[j]!)) j += 1;
      push(spans, "number", line.slice(i, j));
      i = j;
      continue;
    }

    // identifiers
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentCont(line[j]!)) j += 1;
      const word = line.slice(i, j);
      let k = j;
      while (k < n && (line[k] === " " || line[k] === "\t")) k += 1;
      const after = line[k];
      const keyLookup = opts.caseInsensitiveKeywords ? word.toLowerCase() : word;
      const keyHit = opts.caseInsensitiveKeywords
        ? [...keys].some((kw) => kw.toLowerCase() === keyLookup)
        : keys.has(word);

      if (keyHit) push(spans, "keyword", word);
      else if (after === "(") push(spans, "function", word);
      else if (/^[A-Z]/.test(word)) push(spans, "type", word);
      else if (spans[spans.length - 1]?.text.endsWith(".")) push(spans, "property", word);
      else push(spans, "plain", word);
      i = j;
      continue;
    }

    if (/[{}()\[\];,.]/.test(ch)) {
      push(spans, "punctuation", ch);
      i += 1;
      continue;
    }
    if (/[+\-*/%=<>!&|^~?:@]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[+\-*/%=<>!&|^~?:@]/.test(line[j]!)) j += 1;
      push(spans, "operator", line.slice(i, j));
      i = j;
      continue;
    }

    push(spans, "plain", ch);
    i += 1;
  }
  return spans;
}

export function readString(
  line: string,
  start: number,
  quote: string,
  spans: SyntaxSpan[],
): number {
  const n = line.length;
  let j = start + 1;
  while (j < n) {
    if (line[j] === "\\") {
      j += 2;
      continue;
    }
    if (line[j] === quote) {
      j += 1;
      break;
    }
    // template ${ } — keep as string for simplicity
    j += 1;
  }
  push(spans, "string", line.slice(start, j));
  return j;
}

function readRegex(line: string, start: number): number {
  const n = line.length;
  let j = start + 1;
  let closed = false;
  while (j < n) {
    if (line[j] === "\\") {
      j += 2;
      continue;
    }
    if (line[j] === "/") {
      j += 1;
      closed = true;
      break;
    }
    if (line[j] === "\n") break;
    j += 1;
  }
  if (!closed) return start;
  while (j < n && /[gimsuy]/.test(line[j]!)) j += 1;
  return j;
}
