import { KW } from "./keywords.js";
import { HighlightCarry, SyntaxSpan, highlightClike, isIdentCont, isIdentStart, push, readString } from "./clike.js";
export { highlightClike, push };
export type { HighlightCarry, SyntaxKind, SyntaxSpan } from "./clike.js";

export function highlightGeneric(line: string, carry: HighlightCarry): SyntaxSpan[] {
  const t = line.trimStart();
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
  const t = line.trimStart();
  if (t.startsWith(commentChar) && commentChar !== "//") {
    return [{ kind: "comment", text: line }];
  }
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
      const rest = highlightHashCommentLang(line.slice(i), KW.py);
      const sub = rest[0];
      if (!sub) {
        i += 1;
        continue;
      }
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
  const spans = highlightClike(line, KW.php, carry, { regex: false });
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

const CSS_KEYWORDS = new Set([
  "important",
  "and",
  "or",
  "not",
  "only",
  "from",
  "to",
]);

function isCssIdentStart(line: string, index: number): boolean {
  const ch = line[index]!;
  if (/[A-Za-z_]/.test(ch)) return true;
  if (ch === "-") {
    const next = line[index + 1];
    return next !== undefined && /[A-Za-z_-]/.test(next);
  }
  return false;
}

function isCssIdentCont(ch: string): boolean {
  return /[A-Za-z0-9_-]/.test(ch);
}

export function highlightCss(line: string, carry: HighlightCarry): SyntaxSpan[] {
  const spans: SyntaxSpan[] = [];
  const n = line.length;
  let i = 0;
  let depth = carry.cssDepth ?? 0;
  let paren = 0;
  let expectProperty = depth >= 1;
  let declarationColonPending = false;
  let lastColonDeclaration = false;

  const finish = (): SyntaxSpan[] => {
    carry.cssDepth = depth;
    return spans;
  };

  while (i < n) {
    if (carry.inBlockComment) {
      const end = line.indexOf("*/", i);
      if (end < 0) {
        push(spans, "comment", line.slice(i));
        return finish();
      }
      push(spans, "comment", line.slice(i, end + 2));
      carry.inBlockComment = false;
      i = end + 2;
      continue;
    }

    const ch = line[i]!;
    const next = line[i + 1];

    if (ch === "/" && next === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        push(spans, "comment", line.slice(i));
        carry.inBlockComment = true;
        return finish();
      }
      push(spans, "comment", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (ch === "/" && next === "/") {
      push(spans, "comment", line.slice(i));
      return finish();
    }

    if (ch === '"' || ch === "'") {
      i = readString(line, i, ch, spans);
      expectProperty = false;
      continue;
    }

    if (/^url\(\s*[^"')]/.test(line.slice(i))) {
      push(spans, "function", line.slice(i, i + 3));
      push(spans, "punctuation", "(");
      const close = line.indexOf(")", i + 4);
      const end = close < 0 ? n : close;
      push(spans, "string", line.slice(i + 4, end));
      i = end;
      expectProperty = false;
      continue;
    }

    if (ch === "{") {
      push(spans, "punctuation", ch);
      depth += 1;
      expectProperty = true;
      i += 1;
      continue;
    }
    if (ch === "}") {
      push(spans, "punctuation", ch);
      depth = Math.max(0, depth - 1);
      expectProperty = depth >= 1;
      i += 1;
      continue;
    }
    if (ch === "(") {
      push(spans, "punctuation", ch);
      paren += 1;
      expectProperty = true;
      i += 1;
      continue;
    }
    if (ch === ")") {
      push(spans, "punctuation", ch);
      paren = Math.max(0, paren - 1);
      expectProperty = false;
      i += 1;
      continue;
    }
    if (ch === ";") {
      push(spans, "punctuation", ch);
      expectProperty = depth >= 1;
      i += 1;
      continue;
    }
    if (ch === ",") {
      push(spans, "punctuation", ch);
      expectProperty = false;
      i += 1;
      continue;
    }
    if (ch === "[" || ch === "]") {
      push(spans, "punctuation", ch);
      i += 1;
      continue;
    }
    if (ch === ":") {
      push(spans, "punctuation", ch);
      lastColonDeclaration = declarationColonPending;
      declarationColonPending = false;
      i += 1;
      continue;
    }
    if (ch === ".") {
      push(spans, "punctuation", ch);
      i += 1;
      continue;
    }

    if (ch === "#") {
      const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(line.slice(i));
      if (hex) {
        push(spans, "number", hex[0]);
        i += hex[0].length;
        continue;
      }
      const id = /^#[A-Za-z_][A-Za-z0-9_-]*/.exec(line.slice(i));
      if (id) {
        push(spans, "type", id[0]);
        i += id[0].length;
        expectProperty = false;
        continue;
      }
      push(spans, "plain", ch);
      i += 1;
      continue;
    }

    if (ch === "@") {
      const at = /^@[A-Za-z_-][A-Za-z0-9_-]*/.exec(line.slice(i));
      if (at) {
        push(spans, "keyword", at[0]);
        i += at[0].length;
        expectProperty = false;
        continue;
      }
      push(spans, "operator", ch);
      i += 1;
      continue;
    }

    if (ch === "$") {
      const variable = /^\$[A-Za-z_][A-Za-z0-9_-]*/.exec(line.slice(i));
      if (variable) {
        push(spans, "property", variable[0]);
        i += variable[0].length;
        expectProperty = false;
        continue;
      }
      push(spans, "operator", ch);
      i += 1;
      continue;
    }

    if (ch === "&") {
      push(spans, "keyword", ch);
      expectProperty = false;
      i += 1;
      continue;
    }

    if (ch === "!") {
      const bang = /^!([A-Za-z-]+)/.exec(line.slice(i));
      if (bang && CSS_KEYWORDS.has(bang[1]!.toLowerCase())) {
        push(spans, "keyword", bang[0]);
        i += bang[0].length;
        expectProperty = false;
        continue;
      }
      push(spans, "operator", ch);
      i += 1;
      continue;
    }

    const numberMatch = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[a-zA-Z%][a-zA-Z0-9%]*)?/.exec(
      line.slice(i),
    );
    if (
      numberMatch &&
      (/\d/.test(ch) ||
        (ch === "." && next !== undefined && /\d/.test(next)) ||
        (ch === "-" && next !== undefined && /[\d.]/.test(next)))
    ) {
      push(spans, "number", numberMatch[0]);
      i += numberMatch[0].length;
      expectProperty = false;
      continue;
    }

    if (isCssIdentStart(line, i)) {
      let j = i + 1;
      while (j < n && isCssIdentCont(line[j]!)) j += 1;
      const word = line.slice(i, j);
      let k = j;
      while (k < n && (line[k] === " " || line[k] === "\t")) k += 1;
      const after = line[k];
      const declarationContext = depth >= 1 || paren >= 1;
      const lastSpan = spans[spans.length - 1];
      if (lastSpan?.text.endsWith(".")) {
        push(spans, "type", word);
      } else if (lastSpan?.text.endsWith(":") && !lastColonDeclaration) {
        push(spans, "keyword", word);
      } else if (word.startsWith("--")) {
        push(spans, "property", word);
      } else if (expectProperty && declarationContext && after === ":") {
        push(spans, "property", word);
        declarationColonPending = true;
      } else if (after === "(") {
        push(spans, "function", word);
      } else if (CSS_KEYWORDS.has(word.toLowerCase())) {
        push(spans, "keyword", word);
      } else if (!declarationContext) {
        push(spans, "type", word);
      } else {
        push(spans, "plain", word);
      }
      expectProperty = false;
      i = j;
      continue;
    }

    if (/[>+~=|^]/.test(ch)) {
      push(spans, "operator", ch);
      i += 1;
      continue;
    }

    push(spans, "plain", ch);
    i += 1;
  }
  return finish();
}
