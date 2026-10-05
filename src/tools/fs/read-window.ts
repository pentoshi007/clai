import type { ToolResult } from "../../types.js";
import type { FsReadOptions } from "../fs.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { clipReadText, DEFAULT_READ_MAX_BYTES, ReadOutputBudget } from "./read-budget.js";

export const DEFAULT_LINE_WINDOW = 200;

const PATTERN_SCAN_MAX_BYTES = 32 * 1024 * 1024;

const DEFAULT_PATTERN_MAX_MATCHES = 20;

const HARD_PATTERN_MAX_MATCHES = 100;

const DEFAULT_PATTERN_CONTEXT = 2;

const HARD_PATTERN_CONTEXT = 20;

async function* iterateFileLines(
  resolved: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, undefined> {
  const stream = createReadStream(resolved, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  const stop = (): void => { rl.close(); stream.destroy(); };
  signal?.addEventListener("abort", stop, { once: true });
  try {
    signal?.throwIfAborted();
    for await (const line of rl) {
      signal?.throwIfAborted();
      yield line;
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", stop);
    rl.close();
    stream.destroy();
  }
}

function compileReadPattern(
  source: string,
  caseInsensitive?: boolean,
): { ok: true; re: RegExp } | { ok: false; error: string } {
  let trimmed = source.trim();
  if (!trimmed) {
    return {
      ok: false,
      error:
        'fs.read pattern must be a non-empty string. Examples: "function\\\\s+foo", "export function handle", or "/TODO/i". Do not pass an empty pattern.',
    };
  }

  let flags = caseInsensitive ? "i" : "";
  const slashForm = trimmed.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
  if (slashForm) {
    trimmed = slashForm[1]!;
    const fromSlash = slashForm[2] ?? "";
    flags = [
      ...new Set(`${flags}${fromSlash}`.replace(/g/g, "").split("")),
    ].join("");
  }

  if (!trimmed) {
    return {
      ok: false,
      error:
        'fs.read pattern body is empty after stripping /…/ delimiters. Pass a real pattern, e.g. "class\\\\s+App".',
    };
  }

  try {
    return { ok: true, re: new RegExp(trimmed, flags || undefined) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error:
        `Invalid regex pattern: ${msg}. ` +
        `Pass a JS regex source (escape special chars) or /pattern/flags. ` +
        `For literal text with dots/parens, escape them (e.g. "foo\\\\.bar\\\\(") or search with shell.exec then fs.read with offset around the hit line.`,
    };
  }
}

export function resolveLineWindow(
  options: FsReadOptions,
):
  | { ok: true; start: number; limit: number; note?: string }
  | { ok: false; error: string } {
  const hasStart =
    typeof options.startLine === "number" || typeof options.offset === "number";
  const hasEnd = typeof options.endLine === "number";
  const hasLimit = typeof options.limit === "number";
  if (!hasStart && !hasEnd && !hasLimit) {
    return { ok: true, start: 1, limit: DEFAULT_LINE_WINDOW };
  }

  let start = 1;
  let note: string | undefined;
  if (
    typeof options.startLine === "number" &&
    typeof options.offset === "number"
  ) {
    if (options.startLine !== options.offset) {
      note = `note: both startLine=${options.startLine} and offset=${options.offset} set; using startLine`;
    }
    start = options.startLine;
  } else if (typeof options.startLine === "number") {
    start = options.startLine;
  } else if (typeof options.offset === "number") {
    start = options.offset;
  } else if (hasEnd) {
    start = 1;
  }

  if (!Number.isFinite(start)) {
    return { ok: false, error: "fs.read startLine/offset must be a number" };
  }
  start = Math.floor(start);
  if (start === 0) {
    start = 1;
    note = note
      ? `${note}; offset/startLine 0 treated as 1 (lines are 1-indexed)`
      : "note: offset/startLine 0 treated as 1 (lines are 1-indexed)";
  } else if (start < 1) {
    return {
      ok: false,
      error:
        "fs.read startLine/offset must be an integer >= 1 (or 0, treated as 1)",
    };
  }

  let limit: number;
  if (hasEnd) {
    const end = options.endLine!;
    if (!Number.isInteger(end) && !Number.isFinite(end)) {
      return { ok: false, error: "fs.read endLine must be a number" };
    }
    const endLine = Math.floor(end);
    if (endLine < start) {
      return {
        ok: false,
        error: `fs.read requires startLine/offset <= endLine (got ${start}..${endLine})`,
      };
    }
    limit = endLine - start + 1;
    if (hasLimit && options.limit! > 0 && options.limit! < limit) {
      limit = Math.floor(options.limit!);
      note = note
        ? `${note}; limit=${limit} caps endLine window`
        : `note: limit=${limit} caps endLine window`;
    }
  } else if (hasLimit && options.limit! > 0) {
    limit = Math.floor(options.limit!);
  } else {
    limit = DEFAULT_LINE_WINDOW;
  }

  if (limit < 1) {
    return { ok: false, error: "fs.read limit must be a positive integer" };
  }
  limit = Math.min(limit, 5000);
  return note ? { ok: true, start, limit, note } : { ok: true, start, limit };
}

export async function readLineWindow(
  resolved: string,
  start: number,
  limit: number,
  fileBytes: number,
  note?: string,
  maxBytes = DEFAULT_READ_MAX_BYTES,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const collected: string[] = [];
  const budget = new ReadOutputBudget(maxBytes);
  let lineNo = 0;
  let totalLines = 0;
  let reachedEnd = true;
  let clippedLine: number | undefined;

  for await (const line of iterateFileLines(resolved, signal)) {
    lineNo += 1;
    totalLines = lineNo;
    if (lineNo < start) continue;
    if (collected.length < limit) {
      const numbered = `${lineNo}: ${line}`;
      const text = budget.take(numbered);
      if (text !== undefined) collected.push(text);
      if (budget.truncated) {
        reachedEnd = false;
        if (text !== undefined) clippedLine = lineNo;
        break;
      }
    } else {
      reachedEnd = false;
      break;
    }
  }

  if (collected.length === 0) {
    const header =
      `# fs.read path=${resolved} bytes=${fileBytes}\n` +
      (totalLines === 0
        ? `# file is empty\n`
        : `# requested lines ${start}+ but file has only ${totalLines} line(s)\n`) +
      `# next: use a smaller offset, or omit offset/limit for auto-head on large files`;
    return {
      ok: true,
      output: note ? `${header}\n# ${note}` : header,
      truncated: false,
    };
  }

  const first = start;
  const last = start + collected.length - 1;
  const hasMore = !reachedEnd || totalLines > last;
  const totalLabel = reachedEnd ? String(totalLines) : `${totalLines}+`;
  const header =
    `# fs.read path=${resolved} lines=${first}-${last} of ${totalLabel} bytes=${fileBytes}` +
    (note ? `\n# ${note}` : "");
  const next = hasMore
    ? `\n# hasMore=true next=${JSON.stringify({ offset: clippedLine ?? last + 1, limit })}`
    : `\n# hasMore=false`;
  const byteNotice = budget.truncated
    ? `\n# Content capped at maxBytes=${maxBytes}${clippedLine ? `; line ${clippedLine} is incomplete` : ""}. Narrow the range, or read this file alone with a larger maxBytes.`
    : "";
  return {
    ok: true,
    output: `${header}\n${collected.join("\n")}${byteNotice}${next}`,
    truncated: hasMore,
  };
}

export async function readByPattern(
  resolved: string,
  options: FsReadOptions,
  fileBytes: number,
): Promise<ToolResult> {
  const compiled = compileReadPattern(
    options.pattern ?? "",
    options.caseInsensitive,
  );
  if (!compiled.ok) {
    return { ok: false, output: compiled.error, exitCode: 1 };
  }
  const re = compiled.re;
  const context = Math.min(
    HARD_PATTERN_CONTEXT,
    Math.max(0, Math.floor(options.context ?? DEFAULT_PATTERN_CONTEXT)),
  );
  const maxMatches = Math.min(
    HARD_PATTERN_MAX_MATCHES,
    Math.max(1, Math.floor(options.maxMatches ?? DEFAULT_PATTERN_MAX_MATCHES)),
  );

  let rangeStart = 1;
  let rangeEnd = Number.POSITIVE_INFINITY;
  if (
    typeof options.offset === "number" ||
    typeof options.startLine === "number" ||
    typeof options.endLine === "number" ||
    typeof options.limit === "number"
  ) {
    const win = resolveLineWindow(options);
    if (!win.ok) return { ok: false, output: win.error, exitCode: 1 };
    rangeStart = win.start;
    rangeEnd = win.start + win.limit - 1;
  }

  const ring: string[] = [];
  const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  const budget = new ReadOutputBudget(maxBytes);
  const matchBlocks: string[] = [];
  let matches = 0;
  let lineNo = 0;
  let bytesSeen = 0;
  let truncatedScan = false;
  let pendingAfter = 0;
  let currentBlock: string[] = [];

  const flushBlock = () => {
    if (currentBlock.length === 0) return;
    matchBlocks.push(currentBlock.join("\n"));
    currentBlock = [];
  };

  const appendLine = (number: number, line: string): void => {
    const text = budget.take(`${number}: ${line}`);
    if (text !== undefined) currentBlock.push(text);
  };

  for await (const line of iterateFileLines(resolved, options.signal)) {
    lineNo += 1;
    if (lineNo > rangeEnd && pendingAfter === 0) break;
    bytesSeen += Buffer.byteLength(line, "utf8") + 1;
    if (bytesSeen > PATTERN_SCAN_MAX_BYTES) {
      truncatedScan = true;
      break;
    }

    ring.push(clipReadText(line, maxBytes));
    if (ring.length > context + 1) ring.shift();

    const inRange = lineNo >= rangeStart && lineNo <= rangeEnd;
    re.lastIndex = 0;
    const isMatch = inRange && re.test(line);

    if (pendingAfter > 0 && !isMatch) {
      appendLine(lineNo, line);
      if (budget.truncated) break;
      pendingAfter -= 1;
      if (pendingAfter === 0) flushBlock();
      continue;
    }

    if (isMatch && matches < maxMatches) {
      if (pendingAfter === 0 && currentBlock.length > 0) flushBlock();
      if (pendingAfter === 0) {
        const before = ring.slice(0, Math.max(0, ring.length - 1));
        const startCtx = before.slice(Math.max(0, before.length - context));
        const ctxStartLine = lineNo - startCtx.length;
        for (let i = 0; i < startCtx.length; i += 1) {
          appendLine(ctxStartLine + i, startCtx[i]!);
        }
      }
      appendLine(lineNo, line);
      matches += 1;
      if (budget.truncated) break;
      pendingAfter = context;
      if (pendingAfter === 0) flushBlock();
      continue;
    }

    if (isMatch && matches >= maxMatches) {
      matches += 1;
      break;
    }
  }
  flushBlock();

  const capped = matches > maxMatches;
  const shown = Math.min(matches, maxMatches);
  const header =
    `# fs.read path=${resolved} pattern=${JSON.stringify(options.pattern)} ` +
    `matches=${shown}${capped ? `+` : ""} ` +
    `context=${context} bytes=${fileBytes}` +
    (truncatedScan
      ? `\n# scan stopped at ${PATTERN_SCAN_MAX_BYTES} bytes (file large; narrow with startLine/endLine or search with shell.exec)`
      : "") +
    (rangeEnd !== Number.POSITIVE_INFINITY
      ? `\n# searched lines ${rangeStart}-${rangeEnd === Number.POSITIVE_INFINITY ? "∞" : rangeEnd}`
      : "");

  if (shown === 0) {
    return {
      ok: true,
      output:
        `${header}\n# no matches. Try a simpler pattern, caseInsensitive:true, or shell.exec with rg/grep for multi-file hits.\n` +
        `# tip: fs.read with offset/limit to page, or omit pattern for full/auto-head read`,
      truncated: truncatedScan,
    };
  }

  const body = matchBlocks.join("\n--\n");
  const footer = budget.truncated
    ? `\n# hasMore=true (content capped at maxBytes=${maxBytes}; a match or its context is incomplete. Narrow the pattern/range, or read this file alone with a larger maxBytes.)`
    : capped
    ? `\n# hasMore=true (capped at maxMatches=${maxMatches}; raise maxMatches up to ${HARD_PATTERN_MAX_MATCHES} or narrow the range)`
    : `\n# hasMore=false`;
  return {
    ok: true,
    output: `${header}\n${body}${footer}`,
    truncated: truncatedScan || capped || budget.truncated,
  };
}
