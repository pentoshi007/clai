import type { ToolResult } from "../../types.js";
import type { FsReadOptions } from "../fs.js";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** Default lines for auto-head / default line-window limit. */
export const DEFAULT_LINE_WINDOW = 200;

/** Pattern scan hard stop (bytes streamed). */
const PATTERN_SCAN_MAX_BYTES = 32 * 1024 * 1024;

const DEFAULT_PATTERN_MAX_MATCHES = 20;

const HARD_PATTERN_MAX_MATCHES = 100;

const DEFAULT_PATTERN_CONTEXT = 2;

const HARD_PATTERN_CONTEXT = 20;

/** Stream file lines without loading the whole file into memory. */
async function* iterateFileLines(
  resolved: string,
): AsyncGenerator<string, void, undefined> {
  const stream = createReadStream(resolved, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      yield line;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Normalize pattern strings models commonly emit:
 *  - `/foo/i` or `/foo/gim` → body + flags
 *  - bare `foo` → source as-is
 * Never throws; invalid regex returns a clear error the model can fix.
 */
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
  // Accept /pattern/flags form that models often copy from editors.
  const slashForm = trimmed.match(/^\/([\s\S]+)\/([gimsuy]*)$/);
  if (slashForm) {
    trimmed = slashForm[1]!;
    const fromSlash = slashForm[2] ?? "";
    // Drop global — we scan line-by-line; g would make lastIndex sticky bugs.
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
        `For literal text with dots/parens, escape them (e.g. "foo\\\\.bar\\\\(") or use fs.search then fs.read with offset around the hit line.`,
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
    // endLine alone: treat as lines 1..endLine
    start = 1;
  }

  if (!Number.isFinite(start)) {
    return { ok: false, error: "fs.read startLine/offset must be a number" };
  }
  start = Math.floor(start);
  // Models often send 0-based offsets; lines are 1-indexed — coerce gently.
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
  // Hard cap per call so a bad limit cannot dump millions of lines.
  limit = Math.min(limit, 5000);
  return note ? { ok: true, start, limit, note } : { ok: true, start, limit };
}

export async function readLineWindow(
  resolved: string,
  start: number,
  limit: number,
  fileBytes: number,
  note?: string,
): Promise<ToolResult> {
  const collected: string[] = [];
  let lineNo = 0;
  let totalLines = 0;
  let reachedEnd = true;

  for await (const line of iterateFileLines(resolved)) {
    lineNo += 1;
    totalLines = lineNo;
    if (lineNo < start) continue;
    if (collected.length < limit) {
      collected.push(`${lineNo}: ${line}`);
    } else {
      // Keep counting remaining lines for accurate "of N" footer when cheap.
      // For huge files we still stream once; stop counting past a soft ceiling
      // after the window is full so we don't burn CPU on multi-GB logs.
      if (lineNo >= start + limit + 200_000) {
        reachedEnd = false;
        break;
      }
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
    ? `\n# hasMore=true next=${JSON.stringify({ offset: last + 1, limit })}`
    : `\n# hasMore=false`;
  return {
    ok: true,
    output: `${header}\n${collected.join("\n")}${next}`,
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

  // Optional range filter when offset/startLine/endLine also provided.
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

  // Ring buffer of recent lines for leading context.
  const ring: string[] = [];
  const matchBlocks: string[] = [];
  let matches = 0;
  let lineNo = 0;
  let bytesSeen = 0;
  let truncatedScan = false;
  /** Lines still needed as trailing context after a match. */
  let pendingAfter = 0;
  let currentBlock: string[] = [];

  const flushBlock = () => {
    if (currentBlock.length === 0) return;
    matchBlocks.push(currentBlock.join("\n"));
    currentBlock = [];
  };

  for await (const line of iterateFileLines(resolved)) {
    lineNo += 1;
    bytesSeen += Buffer.byteLength(line, "utf8") + 1;
    if (bytesSeen > PATTERN_SCAN_MAX_BYTES) {
      truncatedScan = true;
      break;
    }

    // Maintain ring for context-before (only lines we might need).
    ring.push(line);
    if (ring.length > context + 1) ring.shift();

    const inRange = lineNo >= rangeStart && lineNo <= rangeEnd;
    const isMatch = inRange && re.test(line);

    if (pendingAfter > 0 && !isMatch) {
      currentBlock.push(`${lineNo}: ${line}`);
      pendingAfter -= 1;
      if (pendingAfter === 0) flushBlock();
      // After draining trailing context for the last shown match, keep
      // scanning only long enough to learn whether more matches exist.
      if (matches >= maxMatches && pendingAfter === 0) {
        // fall through to isMatch checks below on later lines
      }
      continue;
    }

    if (isMatch && matches < maxMatches) {
      // If we were still emitting after-context, close previous block first
      // only when this match is outside that window; otherwise merge.
      if (pendingAfter === 0 && currentBlock.length > 0) flushBlock();
      if (pendingAfter === 0) {
        // Leading context from ring (exclude current line, last is current).
        const before = ring.slice(0, Math.max(0, ring.length - 1));
        const startCtx = before.slice(Math.max(0, before.length - context));
        const ctxStartLine = lineNo - startCtx.length;
        for (let i = 0; i < startCtx.length; i += 1) {
          currentBlock.push(`${ctxStartLine + i}: ${startCtx[i]}`);
        }
      }
      currentBlock.push(`${lineNo}: ${line}`);
      matches += 1;
      pendingAfter = context;
      if (pendingAfter === 0) flushBlock();
      // Do not break yet: keep scanning so hasMore can detect further hits.
      continue;
    }

    if (isMatch && matches >= maxMatches) {
      // One more hit beyond the display cap → hasMore.
      matches += 1;
      break;
    }
  }
  if (pendingAfter > 0) flushBlock();

  const capped = matches > maxMatches;
  const shown = Math.min(matches, maxMatches);
  const header =
    `# fs.read path=${resolved} pattern=${JSON.stringify(options.pattern)} ` +
    `matches=${shown}${capped ? `+` : ""} ` +
    `context=${context} bytes=${fileBytes}` +
    (truncatedScan
      ? `\n# scan stopped at ${PATTERN_SCAN_MAX_BYTES} bytes (file large; narrow with startLine/endLine or use fs.search)`
      : "") +
    (rangeEnd !== Number.POSITIVE_INFINITY
      ? `\n# searched lines ${rangeStart}-${rangeEnd === Number.POSITIVE_INFINITY ? "∞" : rangeEnd}`
      : "");

  if (shown === 0) {
    return {
      ok: true,
      output:
        `${header}\n# no matches. Try a simpler pattern, caseInsensitive:true, or fs.search for multi-file hits.\n` +
        `# tip: fs.read with offset/limit to page, or omit pattern for full/auto-head read`,
      truncated: truncatedScan,
    };
  }

  const body = matchBlocks.join("\n--\n");
  const footer = capped
    ? `\n# hasMore=true (capped at maxMatches=${maxMatches}; raise maxMatches up to ${HARD_PATTERN_MAX_MATCHES} or narrow the range)`
    : `\n# hasMore=false`;
  return {
    ok: true,
    output: `${header}\n${body}${footer}`,
    truncated: truncatedScan || capped,
  };
}
