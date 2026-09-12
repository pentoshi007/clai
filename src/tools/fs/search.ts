import { safeCwd } from "../../os/cwd.js";
import type { ToolResult } from "../../types.js";
import { ensureReadAllowed, resolveReadPath } from "./internals.js";
import { execa } from "execa";

export interface FsSearchOptions {
  confirmed?: boolean | undefined;
  maxMatches?: number | undefined;
  maxPerFile?: number | undefined;
  glob?: string | undefined;
  caseInsensitive?: boolean | undefined;
  fixedString?: boolean | undefined;
  context?: number | undefined;
  filesOnly?: boolean | undefined;
  hidden?: boolean | undefined;
  timeoutMs?: number | undefined;
}

const PRUNED_DIRECTORIES = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".venv",
  "__pycache__",
] as const;

const UNSUPPORTED_SYNTAX =
  /look-?(?:around|ahead|behind)|back-?reference|not supported|unsupported/i;

const REGEX_SYNTAX_ERROR =
  /regex parse error|error parsing regex|unmatched|unbalanced|not balanced|parenthes|unterminated|trailing backslash|invalid (?:regular expression|regex|character class|repetition)|repetition (?:operator|quantifier)|nothing to repeat|brackets|\bparse error\b/i;

const PCRE_UNAVAILABLE = /pcre2 is not available|pcre2 unavailable|--pcre2/i;

interface EngineOutcome {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly unavailable: boolean;
}

interface RawOutcome {
  readonly exitCode?: number | undefined;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
  readonly timedOut?: boolean | undefined;
  readonly code?: unknown;
  readonly message?: unknown;
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((entry) => text(entry)).join("\n");
  return String(value);
}

function normalizeOutcome(raw: RawOutcome): EngineOutcome {
  const spawnCode = typeof raw.code === "string" ? raw.code : "";
  const message = text(raw.message);
  return {
    exitCode: typeof raw.exitCode === "number" ? raw.exitCode : undefined,
    stdout: text(raw.stdout),
    stderr: text(raw.stderr),
    timedOut: raw.timedOut === true,
    unavailable:
      spawnCode === "ENOENT" ||
      (typeof raw.exitCode !== "number" && /ENOENT|not found/i.test(message)),
  };
}

async function runEngine(
  file: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<EngineOutcome> {
  try {
    return normalizeOutcome(
      (await execa(file, [...args], {
        reject: false,
        timeout: timeoutMs,
        stripFinalNewline: true,
      })) as unknown as RawOutcome,
    );
  } catch (error) {
    return normalizeOutcome((error ?? {}) as RawOutcome);
  }
}

export function engineGlob(glob: string): string {
  const negated = glob.startsWith("!");
  const body = negated ? glob.slice(1) : glob;
  const anchored =
    !body.includes("/") || body.startsWith("**/") || body.startsWith("/")
      ? body
      : `**/${body}`;
  return negated ? `!${anchored}` : anchored;
}

export function globToPathRegExp(glob: string): RegExp | undefined {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          source += "(?:[^/]*/)*";
        } else {
          source += ".*";
        }
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if (char === "/") {
      source += "/";
      continue;
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`(?:^|/)${source}$`);
  } catch {
    return undefined;
  }
}

export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly match: boolean;
  readonly text: string;
}

const GROUP_SEPARATOR = /^--$/;

const HIT_LINE = /^(.+?)([:-])(\d+)\2(.*)$/;

export function parseHitLine(raw: string): SearchHit | undefined {
  const parsed = HIT_LINE.exec(raw);
  if (!parsed) return undefined;
  const line = Number(parsed[3]);
  if (!Number.isFinite(line)) return undefined;
  return {
    path: parsed[1]!,
    line,
    match: parsed[2] === ":",
    text: parsed[4]!,
  };
}

export function parseEngineOutput(
  stdout: string,
  filesOnly: boolean,
): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.length || GROUP_SEPARATOR.test(raw)) continue;
    if (filesOnly) {
      const path = raw.trim();
      if (path) hits.push({ path, line: 0, match: true, text: "" });
      continue;
    }
    const hit = parseHitLine(raw);
    if (hit) hits.push(hit);
  }
  return hits;
}

export function filterHitsByGlob(
  hits: readonly SearchHit[],
  glob: string | undefined,
): SearchHit[] {
  if (!glob) return [...hits];
  const negated = glob.startsWith("!");
  const matcher = globToPathRegExp(negated ? glob.slice(1) : glob);
  if (!matcher) return [...hits];
  return hits.filter((hit) => matcher.test(hit.path) !== negated);
}

export function capHits(
  hits: readonly SearchHit[],
  maxMatches: number,
): { readonly hits: SearchHit[]; readonly matches: number; readonly truncated: boolean } {
  const kept: SearchHit[] = [];
  let matches = 0;
  let truncated = false;
  for (const hit of hits) {
    if (hit.match) {
      if (matches === maxMatches) {
        truncated = true;
        break;
      }
      matches += 1;
    }
    kept.push(hit);
  }
  while (kept.length > 0 && !kept[kept.length - 1]!.match) kept.pop();
  return { hits: kept, matches, truncated };
}

export function hasHits(stdout: string, filesOnly: boolean): boolean {
  return parseEngineOutput(stdout, filesOnly).length > 0;
}

export function renderHit(hit: SearchHit, filesOnly: boolean): string {
  if (filesOnly) return hit.path;
  const separator = hit.match ? ":" : "-";
  return `${hit.path}${separator}${hit.line}${separator}${hit.text}`;
}

function firstStderrLine(stderr: string): string {
  return (
    stderr
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

function looksLikeRegexPattern(pattern: string): boolean {
  return /[.*+?^$|(){}\[\]\\]/.test(pattern);
}

function formatMatches(input: {
  readonly pattern: string;
  readonly resolved: string;
  readonly lines: readonly string[];
  readonly matches: number;
  readonly truncated: boolean;
  readonly maxMatches: number;
  readonly notes: readonly string[];
}): ToolResult {
  const header =
    `# fs.search pattern=${JSON.stringify(input.pattern)} path=${input.resolved} hits=${input.matches}` +
    (input.truncated ? ` (capped at ${input.maxMatches})` : "");
  const notes = input.notes.map((note) => `# note: ${note}`);
  return {
    ok: true,
    output: [
      header,
      ...notes,
      "# tip: fs.read path=… offset=<line> limit=… or pattern= for a focused window",
      ...input.lines,
    ].join("\n"),
    exitCode: 0,
    ...(input.truncated ? { truncated: true } : {}),
  };
}

function formatEmpty(input: {
  readonly pattern: string;
  readonly resolved: string;
  readonly glob: string | undefined;
  readonly literal: boolean;
  readonly notes: readonly string[];
}): ToolResult {
  const hints: string[] = [...input.notes];
  if (input.glob) {
    hints.push(
      `searched only files matching glob=${JSON.stringify(input.glob)}; retry without glob if that filter is too narrow`,
    );
  }
  if (!input.literal && looksLikeRegexPattern(input.pattern)) {
    hints.push(
      "pattern was treated as a regex; retry with fixedString=true to match it literally",
    );
  }
  return {
    ok: true,
    output: [
      `# fs.search pattern=${JSON.stringify(input.pattern)} path=${input.resolved}`,
      "# no matches",
      ...hints.map((hint) => `# note: ${hint}`),
    ].join("\n"),
    exitCode: 0,
  };
}

function ripgrepArgs(input: {
  readonly pattern: string;
  readonly resolved: string;
  readonly maxPerFile: number;
  readonly context: number;
  readonly literal: boolean;
  readonly pcre: boolean;
  readonly options: FsSearchOptions;
}): string[] {
  const args = [
    "--line-number",
    "--no-heading",
    "--with-filename",
    "--color",
    "never",
    "--max-count",
    String(input.maxPerFile),
    "--max-filesize",
    "1M",
    "--max-columns",
    "300",
    "--max-columns-preview",
  ];
  if (input.options.caseInsensitive) args.push("-i");
  if (input.literal) args.push("-F");
  else if (input.pcre) args.push("-P");
  if (input.options.hidden) args.push("--hidden");
  if (input.options.filesOnly) args.push("-l");
  if (input.context > 0) args.push("-C", String(input.context));
  if (input.options.glob) args.push("-g", engineGlob(input.options.glob));
  args.push("--", input.pattern, input.resolved);
  return args;
}

function grepArgs(input: {
  readonly pattern: string;
  readonly resolved: string;
  readonly maxPerFile: number;
  readonly context: number;
  readonly literal: boolean;
  readonly options: FsSearchOptions;
}): string[] {
  const args = ["-R", "-n", "-H", "-I", "-m", String(input.maxPerFile)];
  args.push(input.literal ? "-F" : "-E");
  if (input.options.caseInsensitive) args.push("-i");
  if (input.options.filesOnly) args.push("-l");
  if (input.context > 0) args.push("-C", String(input.context));
  const glob = input.options.glob;
  if (glob && !glob.includes("/")) {
    args.push(
      glob.startsWith("!")
        ? `--exclude=${glob.slice(1)}`
        : `--include=${glob}`,
    );
  }
  for (const directory of PRUNED_DIRECTORIES) {
    args.push(`--exclude-dir=${directory}`);
  }
  args.push("--", input.pattern, input.resolved);
  return args;
}

export async function fsSearch(
  pattern: string,
  path = safeCwd(),
  options: FsSearchOptions = {},
): Promise<ToolResult> {
  const resolved = resolveReadPath(path);
  ensureReadAllowed(resolved, path, options.confirmed);
  const maxMatches = Math.min(
    200,
    Math.max(1, Math.floor(options.maxMatches ?? 50)),
  );
  const maxPerFile = Math.min(
    200,
    Math.max(1, Math.floor(options.maxPerFile ?? 20)),
  );
  const context = Math.min(10, Math.max(0, Math.floor(options.context ?? 0)));
  const timeoutMs = Math.min(
    120_000,
    Math.max(1_000, Math.floor(options.timeoutMs ?? 15_000)),
  );
  const filesOnly = options.filesOnly === true;
  if (!pattern.trim()) {
    return {
      ok: false,
      output: 'fs.search requires a non-empty "pattern"',
      exitCode: 1,
    };
  }

  const notes: string[] = [];
  let literal = options.fixedString === true;

  const finish = (outcome: EngineOutcome, engineGlobbed: boolean): ToolResult => {
    const parsed = filterHitsByGlob(
      parseEngineOutput(outcome.stdout, filesOnly),
      engineGlobbed ? undefined : options.glob,
    );
    if (outcome.stderr.trim() && outcome.exitCode === 2 && parsed.length > 0) {
      notes.push(`partial results; search reported: ${firstStderrLine(outcome.stderr)}`);
    }
    if (parsed.length === 0) {
      return formatEmpty({
        pattern,
        resolved,
        glob: options.glob,
        literal,
        notes,
      });
    }
    const capped = capHits(parsed, maxMatches);
    return formatMatches({
      pattern,
      resolved,
      lines: capped.hits.map((hit) => renderHit(hit, filesOnly)),
      matches: capped.matches,
      truncated: capped.truncated,
      maxMatches,
      notes,
    });
  };

  const timeoutResult = (outcome: EngineOutcome): ToolResult => {
    const lines = capHits(
      parseEngineOutput(outcome.stdout, filesOnly),
      maxMatches,
    ).hits.map((hit) => renderHit(hit, filesOnly));
    return {
      ok: false,
      output: [
        `fs.search timed out after ${timeoutMs}ms; narrow the search with path=, glob=, or a more specific pattern`,
        ...lines,
      ].join("\n"),
      exitCode: 124,
    };
  };

  let ripgrep = await runEngine(
    "rg",
    ripgrepArgs({
      pattern,
      resolved,
      maxPerFile,
      context,
      literal,
      pcre: false,
      options,
    }),
    timeoutMs,
  );
  if (ripgrep.timedOut) return timeoutResult(ripgrep);

  if (ripgrep.exitCode === 2 && !hasHits(ripgrep.stdout, filesOnly)) {
    if (!literal && UNSUPPORTED_SYNTAX.test(ripgrep.stderr)) {
      const pcre = await runEngine(
        "rg",
        ripgrepArgs({
          pattern,
          resolved,
          maxPerFile,
          context,
          literal,
          pcre: true,
          options,
        }),
        timeoutMs,
      );
      if (pcre.timedOut) return timeoutResult(pcre);
      if (
        !pcre.unavailable &&
        (pcre.exitCode === 0 ||
          pcre.exitCode === 1 ||
          hasHits(pcre.stdout, filesOnly))
      ) {
        notes.push("pattern needed PCRE2 features; searched with rg --pcre2");
        ripgrep = pcre;
      } else if (!PCRE_UNAVAILABLE.test(pcre.stderr)) {
        ripgrep = pcre;
      }
    }
    if (
      !literal &&
      ripgrep.exitCode === 2 &&
      REGEX_SYNTAX_ERROR.test(ripgrep.stderr)
    ) {
      const asLiteral = await runEngine(
        "rg",
        ripgrepArgs({
          pattern,
          resolved,
          maxPerFile,
          context,
          literal: true,
          pcre: false,
          options,
        }),
        timeoutMs,
      );
      if (asLiteral.timedOut) return timeoutResult(asLiteral);
      if (asLiteral.exitCode === 0 || asLiteral.exitCode === 1) {
        literal = true;
        notes.push(
          `pattern is not a valid regex (${firstStderrLine(ripgrep.stderr)}); searched it as a literal string`,
        );
        ripgrep = asLiteral;
      }
    }
  }

  if (
    !ripgrep.unavailable &&
    (ripgrep.exitCode === 0 ||
      ripgrep.exitCode === 1 ||
      hasHits(ripgrep.stdout, filesOnly))
  ) {
    return finish(ripgrep, true);
  }

  const ripgrepFailure = ripgrep.unavailable
    ? ""
    : firstStderrLine(ripgrep.stderr);

  let grep = await runEngine(
    "grep",
    grepArgs({ pattern, resolved, maxPerFile, context, literal, options }),
    timeoutMs,
  );
  if (grep.timedOut) return timeoutResult(grep);

  if (
    !literal &&
    grep.exitCode !== undefined &&
    grep.exitCode > 1 &&
    !hasHits(grep.stdout, filesOnly) &&
    REGEX_SYNTAX_ERROR.test(grep.stderr)
  ) {
    const asLiteral = await runEngine(
      "grep",
      grepArgs({
        pattern,
        resolved,
        maxPerFile,
        context,
        literal: true,
        options,
      }),
      timeoutMs,
    );
    if (asLiteral.timedOut) return timeoutResult(asLiteral);
    if (asLiteral.exitCode === 0 || asLiteral.exitCode === 1) {
      literal = true;
      notes.push(
        `pattern is not a valid regex (${firstStderrLine(grep.stderr)}); searched it as a literal string`,
      );
      grep = asLiteral;
    }
  }

  if (grep.unavailable) {
    return {
      ok: false,
      output: `fs.search failed (need ripgrep or grep on PATH)${ripgrepFailure ? `: ${ripgrepFailure}` : ""}`,
      exitCode: 127,
    };
  }
  if (
    grep.exitCode !== undefined &&
    grep.exitCode > 1 &&
    !hasHits(grep.stdout, filesOnly)
  ) {
    const detail = firstStderrLine(grep.stderr) || ripgrepFailure;
    return {
      ok: false,
      output: `fs.search failed (exit ${grep.exitCode})${detail ? `: ${detail}` : ""}`,
      exitCode: grep.exitCode,
    };
  }
  if (!ripgrep.unavailable && ripgrepFailure) {
    notes.push(`ripgrep declined this search (${ripgrepFailure}); used grep`);
  }
  return finish(grep, false);
}
