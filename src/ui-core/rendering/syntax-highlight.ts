
import { LangFamily, languageFromPath } from "./syntax/language-table.js";
import { KW, keywordSetFor } from "./syntax/keywords.js";
import { HighlightCarry, SyntaxSpan, highlightClike, highlightDiff, highlightGeneric, highlightHaskell, highlightHtml, highlightIniToml, highlightJsonLike, highlightLineCommentLang, highlightLisp, highlightLua, highlightMarkdown, highlightPhp, highlightPython, highlightYaml, push } from "./syntax/language-highlighters.js";
export type { HighlightCarry, SyntaxKind, SyntaxSpan } from "./syntax/language-highlighters.js";
export { supportedExtensions } from "./syntax/language-table.js";
export { languageFromPath };
export type { LangFamily } from "./syntax/language-table.js";


/** @deprecated alias kept for call sites */
export type LangId = LangFamily;

export function emptyCarry(): HighlightCarry {
  return { inBlockComment: false, inTripleString: false };
}


/** @deprecated use languageFromPath */
export function languageFromPathLegacy(path: string): LangId {
  return languageFromPath(path);
}


export function highlightLine(
  line: string,
  langOrPath: LangFamily | string,
  carry: HighlightCarry = emptyCarry(),
): SyntaxSpan[] {
  const family: LangFamily =
    typeof langOrPath === "string" &&
    !(
      [
        "clike",
        "js",
        "css",
        "json",
        "html",
        "md",
        "sh",
        "py",
        "ruby",
        "php",
        "sql",
        "lua",
        "perl",
        "r",
        "haskell",
        "lisp",
        "erlang",
        "fortran",
        "yaml",
        "toml",
        "ini",
        "diff",
        "generic",
      ] as string[]
    ).includes(langOrPath)
      ? languageFromPath(langOrPath)
      : (langOrPath as LangFamily);

  switch (family) {
    case "md":
      return highlightMarkdown(line);
    case "json":
      return highlightJsonLike(line);
    case "css":
      return highlightClike(line, KW.css, carry, { regex: false, hashNumber: true });
    case "html":
      return highlightHtml(line, carry);
    case "yaml":
      return highlightYaml(line);
    case "toml":
    case "ini":
      return highlightIniToml(line);
    case "diff":
      return highlightDiff(line);
    case "sh":
      return highlightLineCommentLang(line, "#", KW.sh, carry);
    case "py":
      return highlightPython(line, carry);
    case "ruby":
      return highlightLineCommentLang(line, "#", KW.ruby, carry);
    case "php":
      return highlightPhp(line, carry);
    case "sql":
      return highlightClike(line, KW.sql, carry, {
        lineComment: "--",
        caseInsensitiveKeywords: true,
      });
    case "lua":
      return highlightLua(line, carry);
    case "perl":
      return highlightLineCommentLang(line, "#", KW.perl, carry);
    case "r":
      return highlightLineCommentLang(line, "#", KW.r, carry);
    case "haskell":
      return highlightHaskell(line, carry);
    case "lisp":
      return highlightLisp(line);
    case "erlang":
      return highlightLineCommentLang(line, "%", KW.erlang, carry);
    case "fortran":
      return highlightLineCommentLang(line, "!", KW.fortran, carry, {
        caseInsensitiveKeywords: true,
      });
    case "js":
      return highlightClike(line, KW.js, carry, { regex: true });
    case "clike":
      return highlightClike(line, keywordSetFor("", "clike"), carry, { regex: false });
    case "generic":
    default:
      return highlightGeneric(line, carry);
  }
}

export function highlightLineForPath(
  line: string,
  path: string,
  carry: HighlightCarry = emptyCarry(),
): SyntaxSpan[] {
  const family = languageFromPath(path);
  if (family === "clike") {
    return highlightClike(line, keywordSetFor(path, "clike"), carry, { regex: false });
  }
  return highlightLine(line, family, carry);
}

export function highlightLines(
  lines: readonly string[],
  langOrPath: LangFamily | string,
): SyntaxSpan[][] {
  const carry = emptyCarry();
  const isPath =
    typeof langOrPath === "string" &&
    (langOrPath.includes("/") || langOrPath.includes(".") || langOrPath.includes("\\"));
  return lines.map((line) =>
    isPath
      ? highlightLineForPath(line, langOrPath, carry)
      : highlightLine(line, langOrPath as LangFamily, carry),
  );
}

export function clipSpans(spans: readonly SyntaxSpan[], maxChars: number): SyntaxSpan[] {
  if (maxChars <= 0) return [];
  const out: SyntaxSpan[] = [];
  let used = 0;
  for (const s of spans) {
    if (used >= maxChars) break;
    const room = maxChars - used;
    if (s.text.length <= room) {
      out.push(s);
      used += s.text.length;
    } else {
      out.push({ kind: s.kind, text: s.text.slice(0, Math.max(0, room - 1)) + "…" });
      break;
    }
  }
  return out;
}
