import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { TOOL_DEFINITIONS } from "../../tools/definitions.js";
import { globToPathRegExp } from "../../tools/fs/search.js";
import type { ToolRunOptions } from "../../tools/tool-types.js";
import type { ToolCall, ToolDefinition, ToolResult } from "../../types.js";

export const TOOL_OUTPUT_LIMIT = 12_000;
const fields: Record<string, readonly string[]> = {
  "fs.read": ["path", "offset", "limit", "startLine", "endLine", "maxBytes"],
  "fs.list": ["path", "maxEntries"],
  "fs.search": ["path", "pattern", "glob", "maxMatches", "caseInsensitive", "fixedString", "hidden", "timeoutMs"],
  "web.search": ["query", "maxResults", "timeoutMs"],
  "web.fetch": ["url", "maxBytes", "timeoutMs"],
};

export const READ_ONLY_TOOLS: ToolDefinition[] = TOOL_DEFINITIONS
  .filter((tool) => Object.hasOwn(fields, tool.name))
  .map((tool) => ({
    ...tool,
    description: tool.name === "fs.search"
      ? "Bounded content search inside cwd returning matching file paths only. Use fs.read on matching files for numbered evidence. Skips symlinks, generated directories, and files over 1 MB; scans at most 64 files. Narrow path/glob before widening."
      : tool.name === "fs.read"
        ? "Read a text file inside cwd with numbered lines. Use offset and limit for focused windows; at most 300 lines and 12000 output characters per call. Files larger than 2 MiB require parent inspection."
        : tool.description,
    parameters: {
      ...tool.parameters,
      properties: Object.fromEntries(Object.entries(tool.parameters.properties)
        .filter(([key]) => fields[tool.name]!.includes(key))),
      additionalProperties: false,
    },
  }));

export function boundedOutput(text: string): string {
  const suffix = "\n[Output truncated; narrow the query or page the file. Coverage is incomplete.]";
  return text.length > TOOL_OUTPUT_LIMIT
    ? text.slice(0, TOOL_OUTPUT_LIMIT - suffix.length) + suffix
    : text;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export async function confinedPath(root: string, value: unknown = "."): Promise<string> {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value !== value.trim()) {
    throw new Error("Invalid path");
  }
  const path = resolve(root, value);
  if (!inside(root, path)) throw new Error("Path is outside the assigned cwd");
  const canonical = await realpath(path);
  if (!inside(root, canonical)) throw new Error("Symlink resolves outside the assigned cwd");
  return canonical;
}

function number(args: Record<string, unknown>, key: string, fallback: number, max: number, min = 1): number {
  const value = args[key] ?? fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new Error(`Invalid ${key}`);
  }
  return Math.min(value, max);
}

function string(args: Record<string, unknown>, key: string, max = 2048): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

export async function prepareReadOnlyCall(root: string, call: ToolCall): Promise<ToolCall> {
  const allowed = fields[call.name];
  if (!Object.hasOwn(fields, call.name) || !allowed) throw new Error(`Tool denied: ${call.name}`);
  if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) throw new Error("Invalid tool arguments");
  for (const key of Object.keys(call.args)) {
    if (!allowed.includes(key)) throw new Error(`Argument denied: ${call.name}.${key}`);
  }
  const args = call.args;
  let safe: Record<string, unknown>;
  if (call.name.startsWith("fs.")) {
    if (call.name === "fs.read" && args.path === undefined) throw new Error("fs.read requires path");
    const path = await confinedPath(root, args.path);
    if (call.name === "fs.read") {
      const offset = number(args, "offset", number(args, "startLine", 1, 10_000_000), 10_000_000, 0) || 1;
      const limit = number(args, "limit", 200, 300);
      const end = number(args, "endLine", offset + limit - 1, 10_000_300);
      if (end < offset) throw new Error("endLine precedes offset");
      safe = { path, offset, limit: Math.min(limit, end - offset + 1), maxBytes: number(args, "maxBytes", TOOL_OUTPUT_LIMIT, TOOL_OUTPUT_LIMIT) };
    } else if (call.name === "fs.list") {
      safe = { path, maxEntries: number(args, "maxEntries", 100, 200) };
    } else {
      safe = {
        path, pattern: string(args, "pattern"),
        maxMatches: number(args, "maxMatches", 30, 100),
        maxPerFile: 1, context: 0, filesOnly: true,
        timeoutMs: number(args, "timeoutMs", 2000, 2000),
      };
      for (const key of ["caseInsensitive", "fixedString", "hidden"]) {
        if (args[key] !== undefined && typeof args[key] !== "boolean") throw new Error(`Invalid ${key}`);
        safe[key] = args[key] ?? false;
      }
      if (args.glob !== undefined) safe.glob = string(args, "glob", 256);
    }
  } else if (call.name === "web.search") {
    safe = { query: string(args, "query"), maxResults: number(args, "maxResults", 5, 5), timeoutMs: number(args, "timeoutMs", 15_000, 30_000) };
  } else {
    const url = new URL(string(args, "url", 4096));
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Only public HTTP(S) web URLs without credentials are allowed");
    safe = { url: url.href, maxBytes: number(args, "maxBytes", 65_536, 65_536), timeoutMs: number(args, "timeoutMs", 15_000, 30_000) };
  }
  return { name: call.name, args: safe };
}

export type ReadOnlyRegistry = (call: ToolCall, options: ToolRunOptions) => Promise<ToolResult>;
const excluded = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", "coverage", ".next", ".venv", "__pycache__"]);

export async function executeReadOnlyCall(root: string, call: ToolCall, execute: ReadOnlyRegistry, options: ToolRunOptions): Promise<ToolResult> {
  options.signal?.throwIfAborted();
  if (!Object.hasOwn(fields, call.name)) throw new Error(`Tool denied: ${call.name}`);
  if (call.name !== "fs.search") {
    const safe = call.name.startsWith("fs.")
      ? { ...call, args: { ...call.args, path: await confinedPath(root, call.args.path) } }
      : call;
    if (safe.name === "fs.read") {
      const stat = await lstat(String(safe.args.path));
      if (!stat.isFile() && !stat.isDirectory()) throw new Error("Only regular files and directories are readable");
      if (stat.isFile() && stat.size > 2 * 1024 * 1024) {
        throw new Error("File exceeds the child 2 MiB read limit; report this coverage gap for parent inspection");
      }
    }
    options.signal?.throwIfAborted();
    const result = await execute(safe, options);
    options.signal?.throwIfAborted();
    return { ...result, output: boundedOutput(result.output) };
  }
  const files: string[] = [];
  const gaps = new Set<string>(["Symlinks, generated directories and files over 1 MB are excluded."]);
  let entries = 0;
  const glob = typeof call.args.glob === "string" ? call.args.glob : undefined;
  const matcher = glob ? globToPathRegExp(glob.startsWith("!") ? glob.slice(1) : glob) : undefined;
  if (glob && !matcher) throw new Error("Invalid search glob");
  const start = String(call.args.path);
  const collect = async (path: string, depth: number): Promise<void> => {
    options.signal?.throwIfAborted();
    if (entries >= 2048 || files.length >= 64 || depth > 16) {
      gaps.add("Search traversal limit reached; narrow path/glob for remaining coverage.");
      return;
    }
    entries += 1;
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) return;
    await confinedPath(root, path);
    if (stat.isFile()) {
      const rel = relative(start, path) || relative(root, path);
      if (stat.size <= 1_048_576 && (!matcher || matcher.test(rel) !== glob!.startsWith("!"))) files.push(path);
    } else if (stat.isDirectory()) {
      const dir = await opendir(path);
      for await (const entry of dir) {
        options.signal?.throwIfAborted();
        if (entries >= 2048 || files.length >= 64) {
          gaps.add("Search traversal limit reached; narrow path/glob for remaining coverage.");
          break;
        }
        entries += 1;
        if (entry.isSymbolicLink()) {
          await confinedPath(root, resolve(path, entry.name));
          continue;
        }
        if (excluded.has(entry.name) || (!call.args.hidden && entry.name.startsWith("."))) continue;
        await collect(resolve(path, entry.name), depth + 1);
      }
    }
  };
  await collect(start, 0);
  let output = "";
  let ok = true;
  let scanned = 0;
  let matched = 0;
  for (const file of files) {
    options.signal?.throwIfAborted();
    const path = await confinedPath(root, file);
    if (!(await lstat(path)).isFile()) throw new Error("Search target is no longer a regular file");
    options.signal?.throwIfAborted();
    const { glob: _glob, ...args } = call.args;
    const result = await execute({ name: call.name, args: { ...args, path } }, options);
    options.signal?.throwIfAborted();
    scanned += 1;
    ok = ok && result.ok;
    if (!result.ok || !/^# no matches$/m.test(result.output)) {
      output += `${result.output}\n`;
      if (result.ok) matched += 1;
    }
    if (matched >= Number(call.args.maxMatches)) {
      gaps.add("Match limit reached; remaining files were not searched.");
      break;
    }
    if (output.length >= TOOL_OUTPUT_LIMIT - 1000) {
      gaps.add("Search output limit reached; remaining files were not searched.");
      break;
    }
  }
  return { ok, output: boundedOutput(`Scanned ${scanned} files; ${matched} matching paths. Use fs.read for numbered evidence. Coverage gaps: ${[...gaps].join(" ")}\n${output || "No matches in the scanned files."}`) };
}
