/**
 * Lightweight terminal syntax highlighter for file-diff cards / pager.
 *
 * Goal: work for **any** common source language without shiki/tree-sitter.
 * Strategy:
 *  - Map hundreds of extensions → language families
 *  - Per-family keyword sets + comment/string rules
 *  - Unknown extensions still get a **generic** highlighter (strings, comments,
 *    numbers, punctuation) so every file type gets useful coloring
 */

export type LangFamily =
  | "clike" // C/C++/C#/Java/Kotlin/Swift/ObjC/… // and /* */ comments
  | "js" // JS/TS family (also regex literals)
  | "css"
  | "json"
  | "html" // HTML/XML/SVG/Vue/Svelte markup
  | "md"
  | "sh"
  | "py"
  | "ruby"
  | "php"
  | "sql"
  | "lua"
  | "perl"
  | "r"
  | "haskell" // -- comments
  | "lisp" // ; comments
  | "erlang" // % comments
  | "fortran" // ! comments
  | "yaml"
  | "toml"
  | "ini"
  | "diff"
  | "generic"; // unknown: strings + comments + numbers

/** @deprecated alias kept for call sites */
export type LangId = LangFamily;

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

export function emptyCarry(): HighlightCarry {
  return { inBlockComment: false, inTripleString: false };
}

// ─── Keyword sets ───────────────────────────────────────────────────────────

const KW = {
  js: words(`
    as async await break case catch class const continue debugger default delete do else
    enum export extends false finally for from function get if implements import in
    instanceof interface let new null of package private protected public return set static
    super switch this throw true try typeof undefined var void while with yield type keyof
    readonly infer never unknown any boolean number string symbol bigint satisfies asserts
    is namespace module declare abstract override
  `),
  py: words(`
    and as assert async await break class continue def del elif else except False finally
    for from global if import in is lambda None nonlocal not or pass raise return True try
    while with yield match case type
  `),
  go: words(`
    break case chan const continue default defer else fallthrough for func go goto if
    import interface map package range return select struct switch type var true false nil iota
  `),
  rs: words(`
    as async await break const continue crate dyn else enum extern false fn for if impl in
    let loop match mod move mut pub ref return self Self static struct super trait true type
    unsafe use where while async await dyn
  `),
  c: words(`
    auto break case char const continue default do double else enum extern float for goto
    if inline int long register restrict return short signed sizeof static struct switch
    typedef union unsigned void volatile while _Bool _Complex _Imaginary true false NULL
    class public private protected virtual template typename namespace using new delete this
    try catch throw const_cast static_cast dynamic_cast reinterpret_cast constexpr noexcept
    override final nullptr bool wchar_t
  `),
  csharp: words(`
    abstract as base bool break byte case catch char checked class const continue decimal
    default delegate do double else enum event explicit extern false finally fixed float for
    foreach goto if implicit in int interface internal is lock long namespace new null object
    operator out override params private protected public readonly ref return sbyte sealed
    short sizeof stackalloc static string struct switch this throw true try typeof uint ulong
    unchecked unsafe ushort using var virtual void volatile while async await nameof record
    init required nint nuint
  `),
  java: words(`
    abstract assert boolean break byte case catch char class const continue default do double
    else enum extends final finally float for goto if implements import instanceof int
    interface long native new package private protected public return short static strictfp
    super switch synchronized this throw throws transient try void volatile while true false
    null var record sealed permits yields yield non-sealed
  `),
  kotlin: words(`
    as as? break class continue do else false for fun if in !in interface is !is null object
    package return super this throw true try typealias typeof val var when while by catch
    constructor delegate dynamic field file finally get import init param property receiver
    set setparam where actual abstract annotation companion const crossinline data enum
    expect external final infix inline inner internal lateinit noinline open operator out
    override private protected public reified sealed suspend tailrec vararg
  `),
  swift: words(`
    associatedtype class deinit enum extension fileprivate func import init inout internal let
    open operator private protocol public rethrows static struct subscript typealias var break
    case continue default defer do else fallthrough for guard if in repeat return switch where
    while as Any catch false is nil super self Self throw true try async await actor some
  `),
  ruby: words(`
    BEGIN END alias and begin break case class def defined? do else elsif end ensure false
    for if in module next nil not or redo rescue retry return self super then true undef
    unless until when while yield
  `),
  php: words(`
    abstract and array as break callable case catch class clone const continue declare default
    do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit
    extends final finally fn for foreach function global goto if implements include include_once
    instanceof insteadof interface isset list match namespace new or print private protected
    public readonly require require_once return static switch throw trait try unset use var
    while xor yield true false null
  `),
  sql: words(`
    select from where insert into values update set delete create table drop alter index view
    join left right inner outer on and or not null as order by group having limit offset union
    all distinct case when then else end exists in between like is primary key foreign
    references constraint default unique check cascade grant revoke commit rollback transaction
    begin true false with recursive
  `),
  lua: words(`
    and break do else elseif end false for function goto if in local nil not or repeat return
    then true until while
  `),
  perl: words(`
    __DATA__ __END__ __FILE__ __LINE__ __PACKAGE__ and cmp continue do else elsif eq exp for
    foreach ge gt if le lock lt m ne next no or package qq qr qw qx redo require return sub
    tr unless until while xor y my our use local
  `),
  r: words(`
    if else repeat while function for in next break TRUE FALSE NULL Inf NaN NA NA_integer_
    NA_real_ NA_complex_ NA_character_ ... ..1
  `),
  haskell: words(`
    case class data default deriving do else foreign if import in infix infixl infixr instance
    let module newtype of then type where _
  `),
  erlang: words(`
    after and andalso band begin bnot bor bsl bsr bxor case catch cond div end fun if let not
    of or orelse receive rem try when xor
  `),
  fortran: words(`
    assign backspace block call close common continue data dimension do else elseif end endfile
    endif enddo entry equivalence external format function goto if implicit inquire integer
    intrinsic open parameter pause print program read real return rewind save stop subroutine
    then write allocate allocatable allocate deallocate module use contains interface pure
    elemental recursive
  `),
  sh: words(`
    if then else elif fi for while until do done case esac in function select time coproc
    true false return exit export local readonly declare typeset alias unalias set unset
    shift break continue source eval exec
  `),
  css: words(`
    important and or not only from to
  `),
} as const;

function words(s: string): Set<string> {
  return new Set(s.split(/\s+/).filter(Boolean));
}

/** extension (no dot) → family */
const EXT_FAMILY: Record<string, LangFamily> = {
  // JS / TS
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  ts: "js",
  mts: "js",
  cts: "js",
  tsx: "js",
  vue: "html",
  svelte: "html",
  astro: "html",
  // web
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  styl: "css",
  stylus: "css",
  html: "html",
  htm: "html",
  xhtml: "html",
  xml: "html",
  xsl: "html",
  xslt: "html",
  svg: "html",
  jsp: "html",
  asp: "html",
  aspx: "html",
  // data
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  ndjson: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  env: "ini",
  properties: "ini",
  // docs
  md: "md",
  mdx: "md",
  markdown: "md",
  rst: "md",
  txt: "generic",
  // shell
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  ksh: "sh",
  csh: "sh",
  tcsh: "sh",
  ps1: "sh",
  psm1: "sh",
  bat: "sh",
  cmd: "sh",
  // python
  py: "py",
  pyw: "py",
  pyi: "py",
  pyx: "py",
  pxd: "py",
  ipynb: "json",
  // ruby
  rb: "ruby",
  rake: "ruby",
  gemspec: "ruby",
  // php
  php: "php",
  phtml: "php",
  // go / rust
  go: "clike",
  rs: "clike",
  // C family
  c: "clike",
  h: "clike",
  cc: "clike",
  cpp: "clike",
  cxx: "clike",
  hpp: "clike",
  hxx: "clike",
  hh: "clike",
  m: "clike",
  mm: "clike",
  cs: "clike",
  java: "clike",
  kt: "clike",
  kts: "clike",
  scala: "clike",
  sc: "clike",
  groovy: "clike",
  gradle: "clike",
  swift: "clike",
  dart: "clike",
  // JVM etc
  clj: "lisp",
  cljs: "lisp",
  cljc: "lisp",
  edn: "lisp",
  lisp: "lisp",
  el: "lisp",
  scm: "lisp",
  ss: "lisp",
  racket: "lisp",
  // functional
  hs: "haskell",
  lhs: "haskell",
  elm: "haskell",
  ml: "clike",
  mli: "clike",
  fs: "clike",
  fsi: "clike",
  fsx: "clike",
  erl: "erlang",
  hrl: "erlang",
  ex: "ruby", // Elixir ~ Ruby-ish # comments
  exs: "ruby",
  // scripting
  pl: "perl",
  pm: "perl",
  t: "perl",
  lua: "lua",
  r: "r",
  R: "r",
  jl: "py", // Julia: # comments like python-ish
  // systems
  zig: "clike",
  nim: "py", // # comments
  v: "clike",
  d: "clike",
  pas: "clike",
  pp: "clike",
  // data / query
  sql: "sql",
  mysql: "sql",
  pgsql: "sql",
  psql: "sql",
  hql: "sql",
  graphql: "js",
  gql: "js",
  prisma: "js",
  // config / devops
  dockerfile: "sh",
  tf: "clike",
  hcl: "clike",
  nix: "clike",
  makefile: "sh",
  mk: "sh",
  cmake: "sh",
  // diff
  diff: "diff",
  patch: "diff",
  // others often in repos
  proto: "clike",
  thrift: "clike",
  avdl: "clike",
  sol: "clike",
  move: "clike",
  wgsl: "clike",
  glsl: "clike",
  vert: "clike",
  frag: "clike",
  hlsl: "clike",
  metal: "clike",
  asm: "generic",
  s: "generic",
  S: "generic",
  f: "fortran",
  f90: "fortran",
  f95: "fortran",
  for: "fortran",
  cob: "generic",
  cbl: "generic",
  vb: "clike",
  vbs: "generic",
  coffee: "js",
  litcoffee: "js",
  ls: "js",
  purescript: "haskell",
  purs: "haskell",
  res: "clike",
  resi: "clike",
  re: "clike",
  rei: "clike",
  mlapp: "generic",
  mat: "generic",
  sas: "generic",
  sparql: "sql",
  rq: "sql",
  turtle: "generic",
  ttl: "generic",
  nq: "generic",
  wasm: "generic",
  wat: "generic",
  csv: "generic",
  tsv: "generic",
  log: "generic",
  lock: "json",
};

const BASENAME_FAMILY: Record<string, LangFamily> = {
  dockerfile: "sh",
  containerfile: "sh",
  makefile: "sh",
  gnumakefile: "sh",
  "cmakelists.txt": "sh",
  "cargo.toml": "toml",
  "pyproject.toml": "toml",
  "package.json": "json",
  "tsconfig.json": "json",
  "jsconfig.json": "json",
  "composer.json": "json",
  gemfile: "ruby",
  rakefile: "ruby",
  podfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  procfile: "sh",
  justfile: "sh",
  "go.mod": "clike",
  "go.sum": "generic",
  ".gitignore": "ini",
  ".dockerignore": "ini",
  ".npmrc": "ini",
  ".env": "ini",
  ".env.local": "ini",
  ".env.development": "ini",
  ".env.production": "ini",
  ".eslintrc": "json",
  ".prettierrc": "json",
  ".babelrc": "json",
};

function keywordSetFor(pathOrExt: string, family: LangFamily): Set<string> {
  const ext = (pathOrExt.split(".").pop() ?? "").toLowerCase();
  if (family === "js") return KW.js;
  if (family === "py") return KW.py;
  if (family === "ruby") return KW.ruby;
  if (family === "php") return KW.php;
  if (family === "sql") return KW.sql;
  if (family === "lua") return KW.lua;
  if (family === "perl") return KW.perl;
  if (family === "r") return KW.r;
  if (family === "haskell") return KW.haskell;
  if (family === "erlang") return KW.erlang;
  if (family === "fortran") return KW.fortran;
  if (family === "sh") return KW.sh;
  if (family === "css") return KW.css;
  if (family === "clike") {
    if (ext === "go") return KW.go;
    if (ext === "rs") return KW.rs;
    if (ext === "cs") return KW.csharp;
    if (ext === "java") return KW.java;
    if (ext === "kt" || ext === "kts") return KW.kotlin;
    if (ext === "swift") return KW.swift;
    if (ext === "dart") return KW.js; // close enough
    return KW.c;
  }
  return new Set();
}

export function languageFromPath(path: string): LangFamily {
  const base = (path.split(/[/\\]/).pop() ?? path).toLowerCase();
  if (BASENAME_FAMILY[base]) return BASENAME_FAMILY[base]!;
  // multi-dot basenames
  for (const [name, fam] of Object.entries(BASENAME_FAMILY)) {
    if (base === name || base.endsWith(name)) return fam;
  }
  const dot = base.lastIndexOf(".");
  if (dot < 0) {
    // shebang-less scripts / Makefile already handled
    return "generic";
  }
  // handle .d.ts, .test.ts etc — use last extension
  const ext = base.slice(dot + 1);
  // double extensions like .d.ts
  if (base.endsWith(".d.ts") || base.endsWith(".d.mts") || base.endsWith(".d.cts")) {
    return "js";
  }
  if (base.endsWith(".test.ts") || base.endsWith(".spec.ts") || base.endsWith(".test.tsx")) {
    return "js";
  }
  return EXT_FAMILY[ext] ?? "generic";
}

/** @deprecated use languageFromPath */
export function languageFromPathLegacy(path: string): LangId {
  return languageFromPath(path);
}

// ─── Core helpers ───────────────────────────────────────────────────────────

function push(spans: SyntaxSpan[], kind: SyntaxKind, text: string): void {
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

/**
 * Highlight one line for any path/language. Unknown types use generic rules.
 */
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
  // re-resolve keywords with extension for clike
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

// ─── Highlighters ───────────────────────────────────────────────────────────

interface ClikeOpts {
  regex?: boolean;
  hashNumber?: boolean;
  lineComment?: string; // default //
  caseInsensitiveKeywords?: boolean;
}

function highlightClike(
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
function highlightGeneric(line: string, carry: HighlightCarry): SyntaxSpan[] {
  const t = line.trimStart();
  // Prefer # line comments for shell-like / config files when whole-line-ish
  if (t.startsWith("#") && !/^#[0-9a-fA-F]{3,8}\b/.test(t)) {
    return [{ kind: "comment", text: line }];
  }
  return highlightClike(line, new Set(), carry, { regex: false });
}

function highlightLineCommentLang(
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

function highlightPython(line: string, carry: HighlightCarry): SyntaxSpan[] {
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

function highlightPhp(line: string, carry: HighlightCarry): SyntaxSpan[] {
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

function highlightLua(line: string, carry: HighlightCarry): SyntaxSpan[] {
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

function highlightHaskell(line: string, carry: HighlightCarry): SyntaxSpan[] {
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

function highlightLisp(line: string): SyntaxSpan[] {
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

function highlightMarkdown(line: string): SyntaxSpan[] {
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

function highlightJsonLike(line: string): SyntaxSpan[] {
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

function highlightHtml(line: string, carry: HighlightCarry): SyntaxSpan[] {
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

function highlightYaml(line: string): SyntaxSpan[] {
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

function highlightIniToml(line: string): SyntaxSpan[] {
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

function highlightDiff(line: string): SyntaxSpan[] {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return [{ kind: "keyword", text: line }];
  }
  if (line.startsWith("@@")) return [{ kind: "function", text: line }];
  if (line.startsWith("+")) return [{ kind: "string", text: line }];
  if (line.startsWith("-")) return [{ kind: "regex", text: line }];
  return [{ kind: "plain", text: line }];
}

/** List of extensions we explicitly map (for tests / docs). */
export function supportedExtensions(): string[] {
  return Object.keys(EXT_FAMILY).sort();
}
