import type { ToolResult } from "../../types.js";
import {
  BINARY_SAMPLE_BYTES,
  ensureReadAllowed,
  resolveReadPath,
} from "./internals.js";
import type { FsReadOptions } from "../fs.js";
import {
  DEFAULT_LINE_WINDOW,
  readByPattern,
  readLineWindow,
  resolveLineWindow,
} from "./read-window.js";
import { open, readdir, stat } from "node:fs/promises";

// Full-file soft caps. Normal source files fit; logs/dumps/minified bundles
// auto-page with a head window + next-offset instructions instead of dumping
// megabytes into context. Hard byte ceiling still applies for raw full reads.
const DEFAULT_READ_MAX_BYTES = 8 * 1024 * 1024;

/** Soft auto-head when full read would blow the budget (bytes). */
const SOFT_FULL_READ_BYTES = 256 * 1024;

/** Soft auto-head when file has more than this many lines. */
const SOFT_FULL_READ_LINES = 2000;

const DEFAULT_LIST_MAX_ENTRIES = 500;

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
        maxEntries:
          options.limit && options.limit > 0 ? options.limit : undefined,
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

export async function fsList(
  path: string,
  options: {
    maxEntries?: number | undefined;
    confirmed?: boolean | undefined;
  } = {},
): Promise<ToolResult> {
  const resolved = resolveReadPath(path);
  ensureReadAllowed(resolved, path, options.confirmed);
  const maxEntries = options.maxEntries ?? DEFAULT_LIST_MAX_ENTRIES;
  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const sorted = [...entries].sort((left, right) =>
      left.name.localeCompare(right.name, undefined, { numeric: true }),
    );
    const hiddenCount = sorted.filter((entry) =>
      entry.name.startsWith("."),
    ).length;
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
      ...visible.map(
        (entry) =>
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
