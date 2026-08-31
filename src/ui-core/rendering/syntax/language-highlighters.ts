import { KW } from "./keywords.js";

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

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$\u00a0-\uffff]/.test(ch);
}

function isIdentCont(ch: string): boolean {
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

function readString(
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

/** Generic: strings, line/block comments, numbers — any unmapped extension. */
export function highlightGeneric(line: string, carry: HighlightCarry): SyntaxSpan[] {
  const t = line.trimStart();
  // Prefer # line comments for shell-like / config files when whole-line-ish
  if (t.startsWith("#") && !/^#[0-9a-fA-F]{3,8}\b/.test(t)) {
    return [{ kind: "comment", text: line }];
  }
  return highlightClike(line, new Set(), carry, { regex: false });
}

export function highlightLineCommentLang(
  line: string,
  commentChar: string,
  keys: Set<string>,
  carry: HighlightCarry,
  opts: { caseInsensitiveKeywords?: boolean } = {},
): SyntaxSpan[] {
  const caseIns = opts.caseInsensitiveKeywords === true;
  // Reuse clike but with custom line comment by pre-check
  const t = line.trimStart();
  if (t.startsWith(commentChar) && commentChar !== "//") {
    return [{ kind: "comment", text: line }];
  }
  // map # comments: temporarily convert? better custom loop
  if (commentChar === "#") {
    return highlightHashCommentLang(line, keys, caseIns);
  }
  if (commentChar === "%" || commentChar === "!") {
    return highlightHashCommentLang(line, keys, caseIns, commentChar);
  }
  return highlightClike(line, keys, carry, {
    caseInsensitiveKeywords: caseIns,
  });
}

function highlightHashCommentLang(
  line: string,
  keys: Set<string>,
  caseInsensitive = false,
  commentChar = "#",
): SyntaxSpan[] {
  const spans: SyntaxSpan[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line[i] === commentChar) {
      push(spans, "comment", line.slice(i));
      return spans;
    }
    if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
      i = readString(line, i, line[i]!, spans);
      continue;
    }
    if (/\d/.test(line[i]!)) {
      let j = i;
      while (j < n && /[\d._]/.test(line[j]!)) j += 1;
      push(spans, "number", line.slice(i, j));
      i = j;
      continue;
    }
    if (isIdentStart(line[i]!)) {
      let j = i + 1;
      while (j < n && isIdentCont(line[j]!)) j += 1;
      const word = line.slice(i, j);
      let k = j;
      while (k < n && /\s/.test(line[k]!)) k += 1;
      const hit = caseInsensitive
        ? [...keys].some((kw) => kw.toLowerCase() === word.toLowerCase())
        : keys.has(word);
      if (hit) push(spans, "keyword", word);
      else if (line[k] === "(") push(spans, "function", word);
      else push(spans, "plain", word);
      i = j;
      continue;
    }
    if (/[{}()\[\];,.]/.test(line[i]!)) {
      push(spans, "punctuation", line[i]!);
      i += 1;
      continue;
    }
    push(spans, "plain", line[i]!);
    i += 1;
  }
  return spans;
}

export function highlightPython(line: string, carry: HighlightCarry): SyntaxSpan[] {
  if (carry.inTripleString) {
    const q = carry.tripleQuote ?? '"""';
    const end = line.indexOf(q);
    if (end < 0) return [{ kind: "string", text: line }];
    carry.inTripleString = false;
    carry.tripleQuote = undefined;
    const spans: SyntaxSpan[] = [{ kind: "string", text: line.slice(0, end + q.length) }];
    if (end + q.length < line.length) {
      spans.push(...highlightPython(line.slice(end + q.length), carry));
    }
    return spans;
  }
  if (line.includes('"""') || line.includes("'''")) {
    const spans: SyntaxSpan[] = [];
    let i = 0;
    const n = line.length;
    while (i < n) {
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        const q = line.slice(i, i + 3);
        const end = line.indexOf(q, i + 3);
        if (end < 0) {
          push(spans, "string", line.slice(i));
          carry.inTripleString = true;
          carry.tripleQuote = q;
          return spans;
        }
        push(spans, "string", line.slice(i, end + 3));
        i = end + 3;
        continue;
      }
      if (line[i] === "#") {
        push(spans, "comment", line.slice(i));
        return spans;
      }
      // fall through one char via rest of hash highlighter
      const rest = highlightHashCommentLang(line.slice(i), KW.py);
      // only take until we'd re-enter — simpler: process char by char for non-triple
      const sub = rest[0];
      if (!sub) {
        i += 1;
        continue;
      }
      // process rest of line with hash highlighter but need to stop at triple
      const piece = line.slice(i);
      const triple = piece.search(/"""|'''/);
      if (triple < 0) {
        spans.push(...highlightHashCommentLang(piece, KW.py));
        return spans;
      }
      if (triple > 0) spans.push(...highlightHashCommentLang(piece.slice(0, triple), KW.py));
      i += triple;
    }
    return spans;
  }
  return highlightHashCommentLang(line, KW.py);
}

export function highlightPhp(line: string, carry: HighlightCarry): SyntaxSpan[] {
  // PHP uses // /* # and $variables
  const spans = highlightClike(line, KW.php, carry, { regex: false });
  // color $ident as property
  const out: SyntaxSpan[] = [];
  for (const s of spans) {
    if (s.kind !== "plain") {
      out.push(s);
      continue;
    }
    const re = /(\$[A-Za-z_][A-Za-z0-9_]*)/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = re.exec(s.text))) {
      any = true;
      if (m.index > last) push(out, "plain", s.text.slice(last, m.index));
      push(out, "property", m[1]!);
      last = m.index + m[1]!.length;
    }
    if (any) {
      if (last < s.text.length) push(out, "plain", s.text.slice(last));
    } else {
      out.push(s);
    }
  }
  return out;
}

export function highlightLua(line: string, carry: HighlightCarry): SyntaxSpan[] {
  // -- line comments, --[[ block ]]
  if (carry.inBlockComment) {
    const end = line.indexOf("]]");
    if (end < 0) return [{ kind: "comment", text: line }];
    carry.inBlockComment = false;
    const spans: SyntaxSpan[] = [{ kind: "comment", text: line.slice(0, end + 2) }];
    if (end + 2 < line.length) spans.push(...highlightLua(line.slice(end + 2), carry));
    return spans;
  }
  if (line.includes("--[[")) {
    const start = line.indexOf("--[[");
    const spans: SyntaxSpan[] = [];
    if (start > 0) spans.push(...highlightHashCommentLang(line.slice(0, start), KW.lua));
    // abuse hash with -- 
    const end = line.indexOf("]]", start + 4);
    if (end < 0) {
      carry.inBlockComment = true;
      spans.push({ kind: "comment", text: line.slice(start) });
      return spans;
    }
    spans.push({ kind: "comment", text: line.slice(start, end + 2) });
    if (end + 2 < line.length) spans.push(...highlightLua(line.slice(end + 2), carry));
    return spans;
  }
  // line --
  const idx = line.indexOf("--");
  if (idx >= 0) {
    const before = line.slice(0, idx);
    const spans = before ? highlightHashCommentLang(before, KW.lua) : [];
    spans.push({ kind: "comment", text: line.slice(idx) });
    return spans;
  }
  return highlightHashCommentLang(line, KW.lua);
}

export function highlightHaskell(line: string, carry: HighlightCarry): SyntaxSpan[] {
  if (carry.inBlockComment) {
    const end = line.indexOf("-}");
    if (end < 0) return [{ kind: "comment", text: line }];
    carry.inBlockComment = false;
    const spans: SyntaxSpan[] = [{ kind: "comment", text: line.slice(0, end + 2) }];
    if (end + 2 < line.length) spans.push(...highlightHaskell(line.slice(end + 2), carry));
    return spans;
  }
  if (line.includes("{-")) {
    const start = line.indexOf("{-");
    const spans: SyntaxSpan[] = [];
    if (start > 0) {
      // -- style via custom
      const before = line.slice(0, start);
      spans.push(...highlightHaskellLine(before));
    }
    const end = line.indexOf("-}", start + 2);
    if (end < 0) {
      carry.inBlockComment = true;
      spans.push({ kind: "comment", text: line.slice(start) });
      return spans;
    }
    spans.push({ kind: "comment", text: line.slice(start, end + 2) });
    if (end + 2 < line.length) spans.push(...highlightHaskell(line.slice(end + 2), carry));
    return spans;
  }
  return highlightHaskellLine(line);
}

function highlightHaskellLine(line: string): SyntaxSpan[] {
  const idx = line.indexOf("--");
  if (idx >= 0) {
    const spans = idx > 0 ? highlightHashCommentLang(line.slice(0, idx), KW.haskell) : [];
    // wrong comment char — use plain keyword pass
    spans.push({ kind: "comment", text: line.slice(idx) });
    return spans;
  }
  return highlightHashCommentLang(line, KW.haskell);
}

export function highlightLisp(line: string): SyntaxSpan[] {
  const t = line.trimStart();
  if (t.startsWith(";")) return [{ kind: "comment", text: line }];
  const spans: SyntaxSpan[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line[i] === ";") {
      push(spans, "comment", line.slice(i));
      return spans;
    }
    if (line[i] === '"' ) {
      i = readString(line, i, '"', spans);
      continue;
    }
    if (line[i] === "(" || line[i] === ")" || line[i] === "[" || line[i] === "]") {
      push(spans, "punctuation", line[i]!);
      i += 1;
      continue;
    }
    if (isIdentStart(line[i]!) || line[i] === ":" || line[i] === "*") {
      let j = i + 1;
      while (j < n && /[^\s()\[\]";]/.test(line[j]!)) j += 1;
      const word = line.slice(i, j);
      // first symbol after ( is function-ish
      const prev = spans[spans.length - 1]?.text;
      if (prev === "(") push(spans, "function", word);
      else if (word.startsWith(":")) push(spans, "property", word);
      else push(spans, "plain", word);
      i = j;
      continue;
    }
    if (/\d/.test(line[i]!)) {
      let j = i;
      while (j < n && /[\d./]/.test(line[j]!)) j += 1;
      push(spans, "number", line.slice(i, j));
      i = j;
      continue;
    }
    push(spans, "plain", line[i]!);
    i += 1;
  }
  return spans;
}

export function highlightMarkdown(line: string): SyntaxSpan[] {
  const t = line.trimStart();
  if (t.startsWith("#")) {
    return [{ kind: "keyword", text: line }];
  }
  if (t.startsWith("```") || t.startsWith("~~~")) {
    return [{ kind: "punctuation", text: line }];
  }
  if (t.startsWith(">") ) {
    return [{ kind: "comment", text: line }];
  }
  if (t.startsWith("- ") || t.startsWith("* ") || /^\d+\.\s/.test(t)) {
    const spans: SyntaxSpan[] = [];
    const indent = line.length - t.length;
    if (indent) push(spans, "plain", line.slice(0, indent));
    const m = t.match(/^([-*]|\d+\.)\s/);
    if (m) {
      push(spans, "keyword", m[0]!);
      push(spans, "plain", t.slice(m[0]!.length));
    } else {
      push(spans, "plain", t);
    }
    return spans;
  }
  // inline `code` and **bold** lightly
  const spans: SyntaxSpan[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end > i) {
        push(spans, "string", line.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    if (line.startsWith("**", i)) {
      const end = line.indexOf("**", i + 2);
      if (end > i) {
        push(spans, "keyword", line.slice(i, end + 2));
        i = end + 2;
        continue;
      }
    }
    if (line[i] === "[") {
      const end = line.indexOf(")", i);
      if (end > i && line.includes("](", i)) {
        push(spans, "property", line.slice(i, end + 1));
        i = end + 1;
        continue;
      }
    }
    push(spans, "plain", line[i]!);
    i += 1;
  }
  return spans;
}

export function highlightJsonLike(line: string): SyntaxSpan[] {
  const spans: SyntaxSpan[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === '"') {
          j += 1;
          break;
        }
        j += 1;
      }
      let k = j;
      while (k < n && /\s/.test(line[k]!)) k += 1;
      push(spans, line[k] === ":" ? "property" : "string", line.slice(i, j));
      i = j;
      continue;
    }
    if (/\d/.test(ch) || (ch === "-" && line[i + 1] && /\d/.test(line[i + 1]!))) {
      let j = i + 1;
      while (j < n && /[\d.eE+-]/.test(line[j]!)) j += 1;
      push(spans, "number", line.slice(i, j));
      i = j;
      continue;
    }
    if (line.startsWith("true", i) || line.startsWith("false", i) || line.startsWith("null", i)) {
      const w = line.startsWith("false", i) ? "false" : line.startsWith("true", i) ? "true" : "null";
      push(spans, "keyword", w);
      i += w.length;
      continue;
    }
    if (/[{}\[\]:,]/.test(ch)) {
      push(spans, "punctuation", ch);
      i += 1;
      continue;
    }
    push(spans, "plain", ch);
    i += 1;
  }
  return spans;
}

export function highlightHtml(line: string, carry: HighlightCarry): SyntaxSpan[] {
  if (carry.inBlockComment || line.includes("<!--")) {
    if (carry.inBlockComment) {
      const end = line.indexOf("-->");
      if (end < 0) return [{ kind: "comment", text: line }];
      carry.inBlockComment = false;
      const spans: SyntaxSpan[] = [{ kind: "comment", text: line.slice(0, end + 3) }];
      if (end + 3 < line.length) spans.push(...highlightHtml(line.slice(end + 3), carry));
      return spans;
    }
    const start = line.indexOf("<!--");
    if (start >= 0) {
      const spans: SyntaxSpan[] = [];
      if (start > 0) spans.push(...highlightHtml(line.slice(0, start), carry));
      const end = line.indexOf("-->", start + 4);
      if (end < 0) {
        carry.inBlockComment = true;
        spans.push({ kind: "comment", text: line.slice(start) });
        return spans;
      }
      spans.push({ kind: "comment", text: line.slice(start, end + 3) });
      if (end + 3 < line.length) spans.push(...highlightHtml(line.slice(end + 3), carry));
      return spans;
    }
  }
  const spans: SyntaxSpan[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (line[i] === "<") {
      const close = line.indexOf(">", i);
      const end = close < 0 ? n : close + 1;
      spans.push(...highlightTag(line.slice(i, end)));
      i = end;
      continue;
    }
    let j = i + 1;
    while (j < n && line[j] !== "<") j += 1;
    push(spans, "plain", line.slice(i, j));
    i = j;
  }
  return spans;
}

function highlightTag(tag: string): SyntaxSpan[] {
  const spans: SyntaxSpan[] = [];
  let i = 0;
  const n = tag.length;
  while (i < n) {
    const ch = tag[i]!;
    if (ch === "<" || ch === ">" || ch === "/") {
      push(spans, "punctuation", ch);
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = readString(tag, i, ch, spans);
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_:-]/.test(tag[j]!)) j += 1;
      const word = tag.slice(i, j);
      const prev = spans[spans.length - 1]?.text;
      if (prev === "<" || prev === "/") push(spans, "keyword", word);
      else push(spans, "property", word);
      i = j;
      continue;
    }
    push(spans, "plain", ch);
    i += 1;
  }
  return spans;
}

export function highlightYaml(line: string): SyntaxSpan[] {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("#")) return [{ kind: "comment", text: line }];
  const spans: SyntaxSpan[] = [];
  const indent = line.length - trimmed.length;
  if (indent) push(spans, "plain", line.slice(0, indent));
  if (trimmed.startsWith("- ")) {
    push(spans, "punctuation", "-");
    push(spans, "plain", " ");
    spans.push(...highlightYaml(trimmed.slice(2)));
    // fix indent double — simpler:
    return [
      ...(indent ? [{ kind: "plain" as const, text: line.slice(0, indent) }] : []),
      { kind: "punctuation", text: "-" },
      { kind: "plain", text: " " },
      ...highlightJsonLike(trimmed.slice(2)),
    ];
  }
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    push(spans, "property", trimmed.slice(0, colon));
    push(spans, "punctuation", ":");
    const rest = trimmed.slice(colon + 1);
    if (rest) spans.push(...highlightJsonLike(rest));
    return spans;
  }
  spans.push(...highlightJsonLike(trimmed));
  return spans;
}

export function highlightIniToml(line: string): SyntaxSpan[] {
  const t = line.trimStart();
  if (t.startsWith("#") || t.startsWith(";")) return [{ kind: "comment", text: line }];
  if (t.startsWith("[") && t.includes("]")) {
    return [{ kind: "keyword", text: line }];
  }
  const eq = line.indexOf("=");
  if (eq > 0) {
    return [
      { kind: "property", text: line.slice(0, eq) },
      { kind: "operator", text: "=" },
      ...highlightJsonLike(line.slice(eq + 1)),
    ];
  }
  return highlightJsonLike(line);
}

export function highlightDiff(line: string): SyntaxSpan[] {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return [{ kind: "keyword", text: line }];
  }
  if (line.startsWith("@@")) return [{ kind: "function", text: line }];
  if (line.startsWith("+")) return [{ kind: "string", text: line }];
  if (line.startsWith("-")) return [{ kind: "regex", text: line }];
  return [{ kind: "plain", text: line }];
}
