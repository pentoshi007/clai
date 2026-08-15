import { createReadStream, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { open, readdir, readFile, writeFile, appendFile, unlink, rm, rename, mkdir, stat, chmod } from "node:fs/promises";
import { join, dirname, basename, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { homedir, tmpdir } from "node:os";
import { execa } from "execa";
import type { ToolResult } from "../types.js";
import { getConfig } from "../store/config.js";
import { safeCwd } from "../os/cwd.js";
import {
  getActiveProjectRoot,
  remapAgentCwdWrite,
  resolveToolPath,
} from "../agent/project-root.js";
import {
  buildFileChange,
  formatUnifiedPreview,
  type FileChange,
} from "./file-diff.js";

/**
 * Atomically replace a file's contents while preserving its permissions.
 *
 * - The temp name is unique per process/attempt, so two concurrent edits of the
 *   same target can never share a staging file and clobber each other.
 * - The original mode is re-applied to the replacement, so an executable script
 *   stays 0755 and a private key/config stays 0600 after an edit.
 * - Data is flushed (fsync) before the rename, and the temp file is removed on
 *   any failure so a crash cannot leave a stray `.clai-*` file behind.
 */
let atomicWriteCounter = 0;

export async function writeFileAtomic(
  resolved: string,
  contents: string,
): Promise<void> {
  const priorMode = await stat(resolved)
    .then((st) => st.mode & 0o7777)
    .catch(() => undefined);
  atomicWriteCounter += 1;
  const unique = `${process.pid}-${Date.now().toString(36)}-${atomicWriteCounter}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const tempPath = join(
    dirname(resolved),
    `.${basename(resolved)}.clai-${unique}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", priorMode ?? 0o644);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (priorMode !== undefined) {
      await chmod(tempPath, priorMode);
    }
    await rename(tempPath, resolved);
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Threshold above which whole-file mutation is refused or replaced by an
 * in-place strategy. Reading and rewriting a very large file holds 2x its size
 * in heap in a process that also carries transcript state.
 */
const LARGE_MUTATION_BYTES = 8 * 1024 * 1024;

/** Compact integrity footer so the model trusts a write without re-reading. */
function describeWrite(path: string, content: string, verb: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = content.length === 0 ? 0 : content.split(/\r?\n/).length;
  const sha = createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
  const lastNonEmpty = content
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0)
    .at(-1);
  const tail = lastNonEmpty
    ? lastNonEmpty.length > 80
      ? `${lastNonEmpty.slice(0, 77)}…`
      : lastNonEmpty
    : "(empty)";
  return (
    `${verb} ${path}\n` +
    `  bytes=${bytes} lines=${lines} sha256_12=${sha}\n` +
    `  ends_with: ${JSON.stringify(tail)}\n` +
    `  Do NOT re-read this file to verify the write unless editing further — trust this receipt.`
  );
}

// Full-file soft caps. Normal source files fit; logs/dumps/minified bundles
// auto-page with a head window + next-offset instructions instead of dumping
// megabytes into context. Hard byte ceiling still applies for raw full reads.
const DEFAULT_READ_MAX_BYTES = 8 * 1024 * 1024;
/** Soft auto-head when full read would blow the budget (bytes). */
const SOFT_FULL_READ_BYTES = 256 * 1024;
/** Soft auto-head when file has more than this many lines. */
const SOFT_FULL_READ_LINES = 2000;
/** Default lines for auto-head / default line-window limit. */
const DEFAULT_LINE_WINDOW = 200;
const DEFAULT_LIST_MAX_ENTRIES = 500;
/** Pattern scan hard stop (bytes streamed). */
const PATTERN_SCAN_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_PATTERN_MAX_MATCHES = 20;
const HARD_PATTERN_MAX_MATCHES = 100;
const DEFAULT_PATTERN_CONTEXT = 2;
const HARD_PATTERN_CONTEXT = 20;
const BINARY_SAMPLE_BYTES = 8192;

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return resolve(homedir(), path.slice(2));
  }
  return path;
}

/** Resolve path with tilde expansion + sticky plan project root for relatives. */
function resolvePath(path: string): string {
  const resolved = resolveToolPath(path);
  return remapAgentCwdWrite(resolved, path);
}

/** Resolve path for reads: tilde expansion + project root for relatives.
 *  Reads should never apply the write-only agent→project remap. */
function resolveReadPath(path: string): string {
  return resolveToolPath(path);
}

/**
 * Decide whether a path falls inside configured sandbox roots / cwd / home.
 * Used for UX (outside-cwd confirm) and optional sandboxReads opt-in.
 * Writes are not hard-blocked by sandbox — outside cwd always prompts instead.
 */
export function pathInsideSandbox(
  resolvedPath: string,
  mode: "read" | "write",
): boolean {
  const roots = [
    ...getConfig().sandboxRoots.map((root) => resolve(expandHome(root))),
    safeCwd(),
    tmpdir(),
  ];
  if (mode === "read") {
    roots.push(homedir());
  }
  return roots.some((root) => {
    const rel = relative(root, resolvedPath);
    return (
      rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."))
    );
  });
}

/** True when target is under root (or equal). */
function isUnderRoot(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel === "" || (!rel.startsWith("..") && !resolve(rel).startsWith(".."));
}

/**
 * Canonicalize an existing target or its nearest existing ancestor. This
 * resolves directory and leaf symlinks even when the final file does not yet
 * exist, so lexical `project/link/file` paths cannot escape a trusted root.
 * Returning undefined is conservative: callers must require confirmation.
 */
function canonicalizeForContainment(path: string): string | undefined {
  let cursor = resolve(path);
  let suffix: string[] = [];
  const visited = new Set<string>();

  while (true) {
    if (visited.has(cursor)) return undefined;
    visited.add(cursor);
    try {
      const entry = lstatSync(cursor);
      if (entry.isSymbolicLink()) {
        const linked = resolve(dirname(cursor), readlinkSync(cursor));
        cursor = resolve(linked, ...suffix);
        suffix = [];
        continue;
      }
      const canonical = realpathSync(cursor);
      return resolve(canonical, ...suffix);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return undefined;
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * True when a write sits outside the working directory and active project
 * root, but not system temp / scratch (agent scratch lives under tmpdir and
 * must not spam confirmations). Default permissions confirm such writes;
 * allow-all auto-approves them. Deletes are handled separately and always
 * confirm.
 */
export function isOutsideWorkingDirectory(resolvedPath: string): boolean {
  const target = canonicalizeForContainment(resolvedPath);
  if (!target) return true;
  const cwd = canonicalizeForContainment(safeCwd());
  if (cwd && isUnderRoot(cwd, target)) return false;
  const projectRoot = getActiveProjectRoot();
  const canonicalProject = projectRoot
    ? canonicalizeForContainment(projectRoot)
    : undefined;
  // A scaffolded/discovered project can intentionally live outside the CLAI
  // process cwd (for example ~/Desktop/bloging-app). Once that root is pinned,
  // writes inside it are part of the active user-approved workspace and should
  // honor allow-all instead of prompting for every file. Siblings and deletes
  // remain protected by the runner's normal confirmation rules.
  if (canonicalProject && isUnderRoot(canonicalProject, target)) return false;
  const canonicalTmp = canonicalizeForContainment(tmpdir());
  if (canonicalTmp && isUnderRoot(canonicalTmp, target)) return false;
  return true;
}

/** Resolve a tool path for permission checks (tilde + project root). */
export function resolveFsToolPath(path: string): string {
  return resolvePath(path);
}

/** Throw with a useful message when a read/list/search escapes the sandbox. */
function ensureReadAllowed(
  resolved: string,
  original: string,
  confirmed?: boolean,
): void {
  if (confirmed) return;
  // Unrestricted reads by default (sandboxReads=false). When enabled, still
  // allow after user confirmation.
  if (getConfig().sandboxReads === false) return;
  if (!pathInsideSandbox(resolved, "read")) {
    throw new Error(
      `Read blocked — "${original}" resolves outside the approved sandbox roots. Add the path with /cwd or sandboxRoots, or set sandboxReads=false.`,
    );
  }
}

/**
 * Resolve path for writes. Outside-cwd is not hard-blocked — the runner
 * confirms such writes under default permissions and honors allow-all. No
 * secret-path gate (pentest must be free to touch .ssh/.env-like paths on
 * targets).
 */
function ensureWriteAllowed(path: string, confirmed?: boolean): string {
  const resolved = resolvePath(path);
  void confirmed;
  return resolved;
}

export interface FsReadOptions {
  maxBytes?: number | undefined;
  confirmed?: boolean | undefined;
  /** 1-indexed first line to return (inclusive). */
  offset?: number | undefined;
  /** Max number of lines to return from `offset`. */
  limit?: number | undefined;
  /** Alias for `offset` (1-indexed inclusive). */
  startLine?: number | undefined;
  /** Inclusive end line; implies a line window when set. */
  endLine?: number | undefined;
  /** Regex source (no surrounding slashes). Return matching windows with context. */
  pattern?: string | undefined;
  /** Lines of context each side of a pattern match (default 2, max 20). */
  context?: number | undefined;
  /** Max pattern matches to return (default 20, hard max 100). */
  maxMatches?: number | undefined;
  /** Case-insensitive pattern match. */
  caseInsensitive?: boolean | undefined;
}

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

async function sampleLooksBinary(resolved: string): Promise<boolean> {
  const handle = await open(resolved, "r");
  try {
    const buf = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, BINARY_SAMPLE_BYTES, 0);
    if (bytesRead === 0) return false;
    const sample = buf.subarray(0, bytesRead);
    // NUL in the first chunk → almost certainly binary.
    if (sample.includes(0)) return true;
    // High ratio of non-text control bytes (excluding tab/lf/cr).
    let control = 0;
    for (let i = 0; i < sample.length; i += 1) {
      const c = sample[i]!;
      if (c < 9 || (c > 13 && c < 32) || c === 127) control += 1;
    }
    return control / sample.length > 0.1;
  } finally {
    await handle.close().catch(() => undefined);
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
    flags = [...new Set(`${flags}${fromSlash}`.replace(/g/g, "").split(""))].join(
      "",
    );
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

function resolveLineWindow(
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
  if (typeof options.startLine === "number" && typeof options.offset === "number") {
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
      error: "fs.read startLine/offset must be an integer >= 1 (or 0, treated as 1)",
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

async function readLineWindow(
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
  const next =
    hasMore
      ? `\n# hasMore=true next=${JSON.stringify({ offset: last + 1, limit })}`
      : `\n# hasMore=false`;
  return {
    ok: true,
    output: `${header}\n${collected.join("\n")}${next}`,
    truncated: hasMore,
  };
}

async function readByPattern(
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
    Math.max(
      1,
      Math.floor(options.maxMatches ?? DEFAULT_PATTERN_MAX_MATCHES),
    ),
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

export async function fsRead(
  path: string,
  options: FsReadOptions = {},
): Promise<ToolResult> {
  const resolved = resolveReadPath(path);
  ensureReadAllowed(resolved, path, options.confirmed);

  // Directory → list contents (models often fs.read a folder by mistake).
  let fileBytes = 0;
  try {
    const st = await stat(resolved);
    if (st.isDirectory()) {
      const listed = await fsList(resolved, {
        maxEntries: options.limit && options.limit > 0 ? options.limit : undefined,
        confirmed: options.confirmed,
      });
      return {
        ...listed,
        output:
          `Path is a directory (not a file): ${resolved}\n` +
          `Listing contents (use fs.list for dirs, fs.read for files):\n\n` +
          (listed.output ?? ""),
      };
    }
    if (!st.isFile()) {
      return {
        ok: false,
        output: `Not a regular file or directory: ${resolved}`,
        exitCode: 1,
      };
    }
    fileBytes = st.size;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, output: msg, exitCode: 1 };
  }

  if (await sampleLooksBinary(resolved)) {
    return {
      ok: false,
      output:
        `Binary or non-text file: ${resolved} (${fileBytes} bytes). ` +
        `Use shell tools for hex/binary inspection, or fs.read with maxBytes only after confirming it is text.`,
      exitCode: 1,
    };
  }

  // 1) Pattern mode
  if (typeof options.pattern === "string") {
    return readByPattern(resolved, options, fileBytes);
  }

  // 2) Explicit line window
  const wantsWindow =
    typeof options.offset === "number" ||
    typeof options.limit === "number" ||
    typeof options.startLine === "number" ||
    typeof options.endLine === "number";
  if (wantsWindow) {
    const win = resolveLineWindow(options);
    if (!win.ok) return { ok: false, output: win.error, exitCode: 1 };
    return readLineWindow(resolved, win.start, win.limit, fileBytes, win.note);
  }

  // 3) Auto-head for large files (soft byte/line budget)
  const maxBytes = options.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  if (fileBytes > SOFT_FULL_READ_BYTES) {
    const result = await readLineWindow(
      resolved,
      1,
      DEFAULT_LINE_WINDOW,
      fileBytes,
      `auto-head: file is ${fileBytes} bytes (>${SOFT_FULL_READ_BYTES}); returning first ${DEFAULT_LINE_WINDOW} lines. ` +
        `Use offset/limit, startLine/endLine, or pattern= to fetch more without loading the whole file.`,
    );
    return { ...result, truncated: true };
  }

  // Full read with hard byte cap (stream into string up to maxBytes).
  const handle = await open(resolved, "r");
  try {
    const st = await handle.stat();
    const cap = Math.min(st.size, maxBytes);
    const buffer = Buffer.alloc(cap);
    const { bytesRead } = await handle.read(buffer, 0, cap, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // Soft line cap even when under byte soft limit (huge single-line minified
    // is handled by bytes; many-line small files by counting).
    const lineCount = text.length === 0 ? 0 : text.split(/\r?\n/).length;
    if (lineCount > SOFT_FULL_READ_LINES && st.size <= maxBytes) {
      // Re-read as window instead of dumping 2k+ lines.
      return readLineWindow(
        resolved,
        1,
        DEFAULT_LINE_WINDOW,
        fileBytes,
        `auto-head: file has ${lineCount} lines (>${SOFT_FULL_READ_LINES}); returning first ${DEFAULT_LINE_WINDOW}. ` +
          `Use offset/limit or pattern= for the rest.`,
      );
    }
    const truncated = st.size > maxBytes;
    const suffix = truncated
      ? `\n# truncated at ${maxBytes.toLocaleString()} bytes of ${st.size.toLocaleString()} — page with offset/limit or pattern= instead of re-reading the whole file`
      : "";
    return {
      ok: true,
      output: truncated
        ? `# fs.read path=${resolved} bytes=${fileBytes} truncated=true\n${text}${suffix}`
        : text,
      truncated,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function fsWrite(
  path: string,
  content: string,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  // Create any missing parent directories so writing "src/index.js" into a
  // fresh project just works — the agent should not have to chain a separate
  // mkdir before every file write. This was the most common failure: ENOENT
  // on a path whose parent dir did not exist yet.
  let before = "";
  let existed = false;
  try {
    before = await readFile(resolved, "utf8");
    existed = true;
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content, "utf8");
  const change = buildFileChange({
    path: resolved,
    before,
    after: content,
    kind: existed ? "overwrite" : "create",
  });
  const verb = existed ? "Wrote" : "Created";
  return {
    ok: true,
    output: describeWrite(resolved, content, verb),
    fileChanges: [change],
  };
}

/** Atomically replace an inclusive, 1-indexed line range in an existing file. */
export async function fsReplaceLines(
  path: string,
  startLine: number,
  endLine: number,
  content: string,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return { ok: false, output: "fs.replaceLines requires integers with 1 <= startLine <= endLine", exitCode: 1 };
  }
  const original = await readFile(resolved, "utf8");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalNewline = original.endsWith("\n");
  const lines = original.split(/\r?\n/);
  if (hadFinalNewline) lines.pop();
  if (endLine > lines.length) {
    return { ok: false, output: `fs.replaceLines range ${startLine}-${endLine} exceeds ${lines.length} lines`, exitCode: 1 };
  }
  const replacement = content === "" ? [] : content.split(/\r?\n/);
  if (replacement.at(-1) === "") replacement.pop();
  lines.splice(startLine - 1, endLine - startLine + 1, ...replacement);
  const next = lines.join(newline) + (hadFinalNewline ? newline : "");
  await writeFileAtomic(resolved, next);
  // X10: receipt with line count + hash so the model notices size changes.
  const verb =
    content === ""
      ? `Deleted lines ${startLine}-${endLine} in`
      : `Replaced lines ${startLine}-${endLine} in`;
  const change = buildFileChange({
    path: resolved,
    before: original,
    after: next,
    kind: "edit",
  });
  return {
    ok: true,
    output: describeWrite(resolved, next, verb),
    fileChanges: [change],
  };
}

export interface FileWrite {
  path: string;
  content: string;
}

const WRITE_MANY_MAX_FILES = 50;

/**
 * Write several files in a single tool call. This is the workhorse for
 * scaffolding a project: a React app, an Express server, etc. all need a
 * handful of files, and forcing one fs.write per file burns through the
 * agent's step budget (the most common reason a scaffold never finished).
 *
 * Each entry is validated and written independently — a bad path does not
 * abort the whole batch. Parent directories are created automatically, just
 * like fs.write.
 */
export async function fsWriteMany(
  files: FileWrite[],
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      output:
        'fs.writeMany requires a non-empty "files" array of { path, content } objects.',
      exitCode: 1,
    };
  }
  if (files.length > WRITE_MANY_MAX_FILES) {
    return {
      ok: false,
      output: `fs.writeMany accepts at most ${WRITE_MANY_MAX_FILES} files per call (got ${files.length}). Split the scaffold into smaller batches.`,
      exitCode: 1,
    };
  }

  const written: string[] = [];
  const failures: string[] = [];
  const changes: FileChange[] = [];
  for (const file of files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      typeof file.content !== "string"
    ) {
      failures.push(
        `invalid entry — each file needs a non-empty string "path" and a string "content": ${JSON.stringify(file)}`,
      );
      continue;
    }
    try {
      const resolved = ensureWriteAllowed(file.path, options.confirmed);
      let before = "";
      let existed = false;
      try {
        before = await readFile(resolved, "utf8");
        existed = true;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
      }
      await mkdir(dirname(resolved), { recursive: true });
      await writeFile(resolved, file.content, "utf8");
      const bytes = Buffer.byteLength(file.content, "utf8");
      const nLines =
        file.content.length === 0 ? 0 : file.content.split(/\r?\n/).length;
      const sha = createHash("sha256")
        .update(file.content, "utf8")
        .digest("hex")
        .slice(0, 12);
      written.push(`${resolved} (bytes=${bytes} lines=${nLines} sha256_12=${sha})`);
      changes.push(
        buildFileChange({
          path: resolved,
          before,
          after: file.content,
          kind: existed ? "overwrite" : "create",
        }),
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      failures.push(`${file.path}: ${msg}`);
    }
  }

  // Clean multi-line receipt: one path per line (UI lists basenames; pager
  // still has full paths). Avoid repeating the same dump twice in the spool.
  const lines: string[] = [];
  if (written.length > 0) {
    lines.push(`Wrote ${written.length} file(s):`);
    for (const p of written) lines.push(`  ${p}`);
  }
  if (failures.length > 0) {
    lines.push(`Failed ${failures.length} file(s):`);
    for (const f of failures) lines.push(`  ${f}`);
  }
  return {
    ok: failures.length === 0,
    output: lines.join("\n"),
    exitCode: failures.length === 0 ? 0 : 1,
    ...(changes.length > 0 ? { fileChanges: changes } : {}),
  };
}

export async function fsList(
  path: string,
  options: { maxEntries?: number | undefined; confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = resolveReadPath(path);
  ensureReadAllowed(resolved, path, options.confirmed);
  const maxEntries = options.maxEntries ?? DEFAULT_LIST_MAX_ENTRIES;
  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const sorted = [...entries].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true }),
    );
    const hiddenCount = sorted.filter((entry) => entry.name.startsWith(".")).length;
    const truncated = sorted.length > maxEntries;
    const visible = truncated ? sorted.slice(0, maxEntries) : sorted;
    if (visible.length === 0) {
      return {
        ok: true,
        output: `(empty directory) ${resolved}`,
        truncated,
      };
    }
    const lines = [
      `Directory ${resolved}: ${sorted.length.toLocaleString()} entr${sorted.length === 1 ? "y" : "ies"} (${hiddenCount.toLocaleString()} hidden included)`,
      ...visible.map((entry) =>
        `${entry.isDirectory() ? "dir " : "file"} ${entry.name}${entry.name.startsWith(".") ? " [hidden]" : ""}`,
      ),
    ];
    if (truncated) {
      lines.push(
        `... (${(sorted.length - maxEntries).toLocaleString()} entries omitted of ${sorted.length.toLocaleString()})`,
      );
    }
    return {
      ok: true,
      output: lines.join("\n"),
      truncated,
    };
  } catch (error: unknown) {
    const err = error as { code?: string; message?: string };
    // Missing path is a valid existence observation for scaffold/preflight —
    // not a hard tool failure that blocks task.done or loop-guard retries.
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
      return {
        ok: true,
        output:
          `path does not exist: ${resolved}\n` +
          `Safe to create/scaffold here. Do not treat this as a tool failure.`,
        exitCode: 0,
      };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: `fs.list failed: ${msg}`,
      exitCode: 1,
    };
  }
}

export async function fsSearch(
  pattern: string,
  path = safeCwd(),
  options: {
    confirmed?: boolean | undefined;
    /** Max matching lines to return (default 50, hard cap 200). */
    maxMatches?: number | undefined;
    /** Max hits per file (default 20). */
    maxPerFile?: number | undefined;
    /** Glob filter passed to ripgrep -g (e.g. "*.ts"). */
    glob?: string | undefined;
    /** Case-insensitive search (-i). */
    caseInsensitive?: boolean | undefined;
    /** Treat the pattern as a literal string (-F). */
    fixedString?: boolean | undefined;
    /** Lines of context around each hit (-C). */
    context?: number | undefined;
    /** Report matching file names only (-l). */
    filesOnly?: boolean | undefined;
    /** Include hidden files/directories (--hidden). */
    hidden?: boolean | undefined;
    timeoutMs?: number | undefined;
  } = {},
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
  const context = Math.min(
    10,
    Math.max(0, Math.floor(options.context ?? 0)),
  );
  const timeoutMs = Math.min(
    120_000,
    Math.max(1_000, Math.floor(options.timeoutMs ?? 15_000)),
  );
  if (!pattern.trim()) {
    return {
      ok: false,
      output: 'fs.search requires a non-empty "pattern"',
      exitCode: 1,
    };
  }

  // Prefer content hits (path:line:text) so the model can jump to fs.read
  // with offset around interesting lines — not just file names.
  try {
    const rgArgs = [
      "--line-number",
      "--no-heading",
      "--color",
      "never",
      // Cap hits per file so one noisy log cannot fill the budget alone.
      "--max-count",
      String(maxPerFile),
      "--max-filesize",
      "1M",
      "--max-columns",
      "300",
      "--max-columns-preview",
    ];
    if (options.caseInsensitive) rgArgs.push("-i");
    if (options.fixedString) rgArgs.push("-F");
    if (options.hidden) rgArgs.push("--hidden");
    if (options.filesOnly) rgArgs.push("-l");
    if (context > 0) rgArgs.push("-C", String(context));
    if (options.glob) rgArgs.push("-g", options.glob);
    // `--` keeps a pattern that starts with `-` from being parsed as a flag.
    rgArgs.push("--", pattern, resolved);
    const result = await execa("rg", rgArgs, {
      reject: false,
      all: true,
      timeout: timeoutMs,
    });
    // rg exit 1 = no matches (still ok for the model); 2 = error
    if (result.exitCode === 0 || result.exitCode === 1) {
      const body = (result.all ?? "").trim();
      if (!body) {
        return {
          ok: true,
          output: `# fs.search pattern=${JSON.stringify(pattern)} path=${resolved}\n# no matches`,
          exitCode: 0,
        };
      }
      const allLines = body.split("\n").filter(Boolean);
      const lines = allLines.slice(0, maxMatches);
      const truncated = allLines.length > maxMatches;
      return {
        ok: true,
        output:
          `# fs.search pattern=${JSON.stringify(pattern)} path=${resolved} hits=${lines.length}` +
          (truncated ? ` (capped at ${maxMatches})` : "") +
          `\n# tip: fs.read path=… offset=<line> limit=… or pattern= for a focused window\n` +
          lines.join("\n"),
        exitCode: 0,
        truncated,
      };
    }
    // Fall through to grep on rg hard failure.
  } catch {
    // rg missing — try grep
  }

  try {
    const grepArgs = ["-R", "-n", "-I", "-m", String(maxPerFile)];
    if (options.caseInsensitive) grepArgs.push("-i");
    if (options.fixedString) grepArgs.push("-F");
    if (options.filesOnly) grepArgs.push("-l");
    if (context > 0) grepArgs.push("-C", String(context));
    if (options.glob) grepArgs.push(`--include=${options.glob}`);
    grepArgs.push("--", pattern, resolved);
    const result = await execa("grep", grepArgs, {
      reject: false,
      all: true,
      timeout: timeoutMs,
    });
    const body = (result.all ?? "").trim();
    if (!body || result.exitCode === 1) {
      return {
        ok: true,
        output: `# fs.search pattern=${JSON.stringify(pattern)} path=${resolved}\n# no matches`,
        exitCode: 0,
      };
    }
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      return {
        ok: false,
        output: body || `fs.search failed (exit ${result.exitCode})`,
        exitCode: result.exitCode ?? 1,
      };
    }
    return {
      ok: true,
      output:
        `# fs.search pattern=${JSON.stringify(pattern)} path=${resolved}\n` +
        `# tip: fs.read path=… offset=<line> limit=… for a focused window\n` +
        body,
      exitCode: 0,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      output: `fs.search failed (need ripgrep or grep): ${msg}`,
      exitCode: 1,
    };
  }
}

/**
 * Atomic search-and-replace edit. Reads the file, validates the match
 * count, performs replacement, and writes back.
 */
export async function fsEdit(
  path: string,
  oldText: string,
  newText: string,
  expectedReplacements?: number | undefined,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  const priorStat = await stat(resolved).catch(() => undefined);
  if (priorStat?.isFile() && priorStat.size > LARGE_MUTATION_BYTES) {
    return {
      ok: false,
      output:
        `fs.edit refuses ${resolved}: ${priorStat.size.toLocaleString()} bytes exceeds the ${Math.round(LARGE_MUTATION_BYTES / (1024 * 1024))}MB whole-file edit limit. ` +
        `Use fs.replaceLines for a bounded line range, or a streaming tool (sed -i / awk) via shell.exec.`,
      exitCode: 1,
    };
  }
  const content = await readFile(resolved, "utf8");
  const expected = expectedReplacements ?? 1;

  let targetOldText = oldText;
  let targetNewText = newText;

  // Count occurrences (exact match first)
  let count = 0;
  let searchPos = 0;
  while (true) {
    const idx = content.indexOf(targetOldText, searchPos);
    if (idx === -1) break;
    count += 1;
    searchPos = idx + targetOldText.length;
  }

  // Fallback: match CRLF / LF line ending differences or trailing whitespace
  if (count === 0) {
    const hasCRLF = content.includes("\r\n");
    const candidateOld = hasCRLF
      ? oldText.replace(/\r?\n/g, "\r\n")
      : oldText.replace(/\r\n/g, "\n");
    const candidateNew = hasCRLF
      ? newText.replace(/\r?\n/g, "\r\n")
      : newText.replace(/\r\n/g, "\n");

    let altCount = 0;
    let altPos = 0;
    while (true) {
      const idx = content.indexOf(candidateOld, altPos);
      if (idx === -1) break;
      altCount += 1;
      altPos = idx + candidateOld.length;
    }

    if (altCount > 0) {
      targetOldText = candidateOld;
      targetNewText = candidateNew;
      count = altCount;
    } else {
      const trimmedOld = candidateOld.trimEnd();
      if (trimmedOld.length > 0) {
        let trimCount = 0;
        let trimPos = 0;
        while (true) {
          const idx = content.indexOf(trimmedOld, trimPos);
          if (idx === -1) break;
          trimCount += 1;
          trimPos = idx + trimmedOld.length;
        }
        if (trimCount > 0) {
          targetOldText = trimmedOld;
          targetNewText = candidateNew.trimEnd();
          count = trimCount;
        }
      }
    }
  }

  if (count === 0) {
    return {
      ok: false,
      output: `No matches found for the search text in ${resolved}. The text to replace was not found.`,
      exitCode: 1,
    };
  }
  if (count !== expected) {
    return {
      ok: false,
      output: `Found ${count} occurrence(s) of the search text, but expected exactly ${expected}. Aborting to avoid unintended changes. Use expectedReplacements=${count} if you want to replace all.`,
      exitCode: 1,
    };
  }

  const updated = content.replaceAll(targetOldText, targetNewText);

  // Atomic, mode-preserving, race-safe replacement.
  await writeFileAtomic(resolved, updated);

  const change = buildFileChange({
    path: resolved,
    before: content,
    after: updated,
    kind: "edit",
  });
  const preview = formatUnifiedPreview(change, { maxLines: 24 });
  return {
    ok: true,
    output: `Replaced ${count} occurrence(s) in ${resolved}.\n${preview}`,
    fileChanges: [change],
  };
}

/**
 * Delete a file or directory. Requires the path to be inside the
 * write sandbox and not a secret path.
 */
export async function fsDelete(
  path: string,
  recursive?: boolean | undefined,
  options: { confirmed?: boolean | undefined } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  try {
    // Snapshot text content for diff UI when deleting a single small file.
    let before = "";
    let canDiff = false;
    if (!recursive) {
      try {
        const st = await stat(resolved);
        if (st.isFile() && st.size <= 200_000) {
          before = await readFile(resolved, "utf8");
          canDiff = true;
        }
      } catch {
        /* ignore — delete may still succeed or fail below */
      }
    }
    if (recursive) {
      await rm(resolved, { recursive: true, force: false });
      return { ok: true, output: `Deleted (recursive): ${resolved}` };
    }
    await unlink(resolved);
    const change = canDiff
      ? buildFileChange({
          path: resolved,
          before,
          after: "",
          kind: "delete",
        })
      : buildFileChange({
          path: resolved,
          before: "",
          after: "",
          kind: "delete",
        });
    return {
      ok: true,
      output: `Deleted: ${resolved}`,
      fileChanges: [change],
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `Delete failed: ${msg}`, exitCode: 1 };
  }
}

export async function fsAppend(
  path: string,
  content: string,
  options: {
    position?: "start" | "end" | undefined;
    confirmed?: boolean | undefined;
    /**
     * Optional integrity check: expected UTF-8 byte length of the file
     * *before* this append. Prevents double-append / wrong-base corruption
     * when continuing a truncated write.
     */
    expectedPriorBytes?: number | undefined;
  } = {},
): Promise<ToolResult> {
  const resolved = ensureWriteAllowed(path, options.confirmed);
  const position = options.position ?? "end";
  if (position !== "start" && position !== "end") {
    return {
      ok: false,
      output: `Invalid position: "${position}". Must be "start" or "end".`,
      exitCode: 1,
    };
  }

  let original = "";
  // Large-file guard: reading + rewriting a 500 MB log to append a few lines
  // holds 2x the file in heap. Above the threshold, append in place with
  // `appendFile` and say the diff was skipped for size.
  const priorStat = await stat(resolved).catch(() => undefined);
  if (
    priorStat?.isFile() &&
    priorStat.size > LARGE_MUTATION_BYTES &&
    position === "end"
  ) {
    const priorBytesLarge = priorStat.size;
    if (
      typeof options.expectedPriorBytes === "number" &&
      options.expectedPriorBytes !== priorBytesLarge
    ) {
      return {
        ok: false,
        output:
          `fs.append integrity check failed for ${resolved}: expected prior bytes=${options.expectedPriorBytes}, actual=${priorBytesLarge}. ` +
          `Do NOT append again until you reconcile (read the last ~20 lines or re-write).`,
        exitCode: 1,
      };
    }
    await appendFile(resolved, content, "utf8");
    const afterStat = await stat(resolved).catch(() => undefined);
    return {
      ok: true,
      output:
        describeWrite(resolved, content, "Appended (end) to") +
        `\n  prior_bytes=${priorBytesLarge} after_bytes=${afterStat?.size ?? priorBytesLarge + Buffer.byteLength(content, "utf8")}` +
        `\n  note: file exceeds ${Math.round(LARGE_MUTATION_BYTES / (1024 * 1024))}MB — appended in place and skipped the diff/receipt hash of the whole file.`,
    };
  }
  try {
    original = await readFile(resolved, "utf8");
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    if (
      typeof options.expectedPriorBytes === "number" &&
      options.expectedPriorBytes !== 0
    ) {
      return {
        ok: false,
        output:
          `fs.append integrity check failed: expected prior bytes=${options.expectedPriorBytes} but file does not exist.`,
        exitCode: 1,
      };
    }
    // File does not exist: create missing parent directories and write content
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf8");
    const change = buildFileChange({
      path: resolved,
      before: "",
      after: content,
      kind: "create",
    });
    return {
      ok: true,
      output: describeWrite(resolved, content, "Created"),
      fileChanges: [change],
    };
  }

  const priorBytes = Buffer.byteLength(original, "utf8");
  if (
    typeof options.expectedPriorBytes === "number" &&
    options.expectedPriorBytes !== priorBytes
  ) {
    return {
      ok: false,
      output:
        `fs.append integrity check failed for ${resolved}: expected prior bytes=${options.expectedPriorBytes}, actual=${priorBytes}. ` +
        `Do NOT append again until you reconcile (read the last ~20 lines or re-write).`,
      exitCode: 1,
    };
  }

  let next = "";
  if (position === "start") {
    next = content + original;
  } else {
    next = original + content;
  }

  // Atomic, mode-preserving, race-safe replacement.
  await writeFileAtomic(resolved, next);

  const st = await stat(resolved).catch(() => undefined);
  const change = buildFileChange({
    path: resolved,
    before: original,
    after: next,
    kind: "append",
  });
  return {
    ok: true,
    output:
      describeWrite(resolved, next, `Appended (${position}) to`) +
      `\n  prior_bytes=${priorBytes} after_bytes=${st?.size ?? Buffer.byteLength(next, "utf8")}`,
    fileChanges: [change],
  };
}
