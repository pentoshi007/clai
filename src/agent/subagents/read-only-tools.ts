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
  "web.fetch": ["url", "maxBytes", "timeoutMs", "responseMode", "responsePart"],
  "http.fetch": ["url", "maxBytes", "timeoutMs", "responseMode", "responsePart"],
  "pdf.read": ["path", "firstPage", "lastPage", "maxPages", "maxChars"],
  "image.view": ["path", "paths"],
  "image.ocr": ["path", "lang", "psm", "preprocess"],
  "sysinfo": [],
  "tool.check": ["tools"],
  "wordlist.find": ["query", "expand"],
  "skill.load": ["name"],
  "skill.list": ["query"],
  "shell.exec": ["command", "timeoutMs"],
};

const descriptions: Record<string, string> = {
  "fs.read": "Read a text file inside cwd with numbered lines. At most 300 lines and 12000 characters per call. Files over 2 MiB need parent inspection.",
  "fs.list": "List directory entries inside cwd.",
  "fs.search": "Bounded content search inside cwd returning matching file paths only. Skips symlinks, generated directories, and files over 1 MB; scans at most 64 files.",
  "web.search": "Search the web for current information.",
  "web.fetch": "Fetch a public URL as readable text.",
  "http.fetch": "GET-only HTTP evidence for public targets. Mutating or authenticated requests are denied.",
  "pdf.read": "Extract text from a PDF inside cwd with bounded paging.",
  "image.view": "View image bytes for a file inside cwd.",
  "image.ocr": "OCR text from an image file inside cwd.",
  "sysinfo": "OS and environment facts.",
  "tool.check": "Check tool availability on PATH.",
  "wordlist.find": "Locate wordlists on disk.",
  "skill.load": "Read one skill's instructions.",
  "skill.list": "List installed skills.",
  "shell.exec": "Read-only shell fallback for search and inspection when file search is insufficient. Writes, redirects, chaining, and installs are denied.",
};

export const READ_ONLY_TOOLS: ToolDefinition[] = TOOL_DEFINITIONS
  .filter((tool) => Object.hasOwn(fields, tool.name))
  .map((tool) => ({
    ...tool,
    description: descriptions[tool.name] ?? tool.description,
    parameters: {
      ...tool.parameters,
      properties: Object.fromEntries(Object.entries(tool.parameters.properties)
        .filter(([key]) => fields[tool.name]!.includes(key))
        .map(([key, schema]) => {
          const { description: _dropped, ...rest } = schema as Record<string, unknown>;
          return [key, rest];
        })),
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
  const canonicalRoot = await realpath(root);
  const path = resolve(canonicalRoot, value);
  if (!inside(canonicalRoot, path)) throw new Error("Path is outside the assigned cwd");
  const canonical = await realpath(path);
  if (!inside(canonicalRoot, canonical)) throw new Error("Symlink resolves outside the assigned cwd");
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

function optionalString(args: Record<string, unknown>, key: string, max = 2048): string | undefined {
  if (args[key] === undefined) return undefined;
  return string(args, key, max);
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== "boolean") throw new Error(`Invalid ${key}`);
  return args[key];
}

function optionalNumber(args: Record<string, unknown>, key: string, max: number, min = 1): number | undefined {
  if (args[key] === undefined) return undefined;
  return number({ ...args, [key]: args[key] }, key, args[key] as number, max, min);
}

function optionalEnum(args: Record<string, unknown>, key: string, allowed: readonly string[]): string | undefined {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== "string" || !allowed.includes(args[key])) throw new Error(`Invalid ${key}`);
  return args[key];
}

function stringList(value: unknown, key: string, min: number, max: number, itemMax = 2048): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`Invalid ${key}`);
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.length > itemMax || entry.includes("\0")) throw new Error(`Invalid ${key}`);
    return entry;
  });
}

const SHELL_FIRST_ALLOW = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "find", "ls", "dir", "cat", "head", "tail", "wc",
  "sort", "uniq", "cut", "tr", "file", "stat", "du",
  "git", "python3", "python", "node", "jq",
  "diff", "cmp", "comm", "strings", "xxd", "od",
]);

const GIT_READ_SUBCOMMANDS = new Set([
  "grep", "log", "show", "diff", "status", "ls-files",
  "blame", "rev-parse", "ls-tree", "cat-file",
]);

const SHELL_CONTENT_DENY: readonly RegExp[] = [
  /-delete\b/, /-exec(dir)?\b/, /-ok\b/, /-fls\b/, /-fprint\b/,
  /subprocess/, /os\.system/, /os\.popen/, /os\.exec\w*\b/, /os\.spawn\w*\b/,
  /os\.remove/, /os\.unlink/, /os\.rmdir/, /os\.mkdir/, /os\.rename/, /os\.replace/,
  /os\.chmod/, /os\.chown/, /os\.symlink/, /os\.link/, /os\.truncate/, /os\.write/,
  /os\.environ/, /getenv/, /shutil/, /socket/, /urllib/, /requests/, /http\.client/,
  /ftplib/, /smtplib/, /telnetlib/, /child_process/, /process\.env/,
  /require\s*\(\s*['"]fs['"]\s*\)/, /from\s+['"]fs['"]/, /import\s*\(\s*['"]fs['"]/,
  /writefilesync/, /appendfilesync/, /mkdirsync/, /rmsync/, /unlinksync/, /rmdirsync/,
  /renamesync/, /chmodsync/, /chownsync/, /truncatesync/, /createwritestream/,
  /write_text/, /write_bytes/, /__import__/, /getattr\s*\(/, /setattr\s*\(/, /delattr\s*\(/,
  /globals\s*\(/, /locals\s*\(/, /compile\s*\(/, /\beval\s*\(/, /\bexec\s*\(/,
  /\binput\s*\(/, /\bfetch\s*\(/, /o_wronly/, /o_rdwr/, /o_creat/,
  /ld_preload/, /ld_library_path/, /pythonpath/, /pythonhome/, /node_options/,
  /open\s*\([^,]+,\s*['"][^'"]*[wax+]/,
];

function stripQuoted(command: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      out += " ";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
    } else if (ch === "\\") {
      i++;
      out += " ";
    } else out += ch;
  }
  return out;
}

function denyShellStructure(visible: string): void {
  if (/`|\$\(|\$\{/.test(visible)) throw new Error("Command denied: shell expansion is not allowed");
  if (/[><]/.test(visible)) throw new Error("Command denied: redirection is not allowed");
  if (/[;&]/.test(visible)) throw new Error("Command denied: run one command per call without chaining");
  if (/(^|[\s"'=:(,])\.\.(\/|\\|$|["'\s])/.test(visible)) throw new Error("Command denied: paths must stay inside the assignment directory");
  if (/(^|[\s"'=:(,])~(\/|$)/.test(visible)) throw new Error("Command denied: home-directory paths are not allowed");
  if (/(^|[\s"'=:(,])\//.test(visible)) throw new Error("Command denied: absolute paths are not allowed");
}

function denyShellContent(lower: string): void {
  if (SHELL_CONTENT_DENY.some((pattern) => pattern.test(lower))) throw new Error("Command denied: mutating, network, or environment access is not allowed");
}

function assertShellSegment(segment: string): void {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();
  if (!first || !SHELL_FIRST_ALLOW.has(first)) throw new Error("Command denied: use a read-only search or inspection command");
  if (first === "git" && !GIT_READ_SUBCOMMANDS.has(tokens[1]?.toLowerCase() ?? "")) throw new Error("Command denied: only read-only git subcommands are allowed");
  if (first === "find" && /-(delete|exec(dir)?|ok|fls|fprint)\b/.test(segment)) throw new Error("Command denied: find may not modify or execute");
  if (first === "sort" && /-o\b|--output\b/.test(segment)) throw new Error("Command denied: sort may not write files");
}

async function prepareShellExec(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = string(args, "command", 4000).trim();
  if (!raw) throw new Error("Invalid command");
  if (/[\r\n]/.test(raw)) throw new Error("Command denied: run one command per call without line breaks");
  const visible = stripQuoted(raw);
  denyShellStructure(visible);
  denyShellContent(raw.toLowerCase());
  for (const segment of visible.split("|")) assertShellSegment(segment);
  return { command: raw, cwd: await confinedPath(root, "."), timeoutMs: number(args, "timeoutMs", 15_000, 30_000), background: "never" };
}

function publicUrl(value: unknown, maxBytesFallback: number): { url: string; maxBytes: number; timeoutMs: number } {
  const href = new URL(string({ url: value }, "url", 4096)).href;
  const parsed = new URL(href);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Only public HTTP(S) web URLs without credentials are allowed");
  return { url: parsed.href, maxBytes: maxBytesFallback, timeoutMs: 15_000 };
}

async function prepareFsRead(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (args.path === undefined) throw new Error("fs.read requires path");
  const path = await confinedPath(root, args.path);
  const offset = number(args, "offset", number(args, "startLine", 1, 10_000_000), 10_000_000, 0) || 1;
  const limit = number(args, "limit", 200, 300);
  const end = number(args, "endLine", offset + limit - 1, 10_000_300);
  if (end < offset) throw new Error("endLine precedes offset");
  return { path, offset, limit: Math.min(limit, end - offset + 1), maxBytes: number(args, "maxBytes", TOOL_OUTPUT_LIMIT, TOOL_OUTPUT_LIMIT) };
}

async function prepareFsList(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return { path: await confinedPath(root, args.path), maxEntries: number(args, "maxEntries", 100, 200) };
}

async function prepareFsSearch(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const safe: Record<string, unknown> = {
    path: await confinedPath(root, args.path), pattern: string(args, "pattern"),
    maxMatches: number(args, "maxMatches", 30, 100),
    maxPerFile: 1, context: 0, filesOnly: true,
    timeoutMs: number(args, "timeoutMs", 2000, 2000),
  };
  for (const key of ["caseInsensitive", "fixedString", "hidden"]) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") throw new Error(`Invalid ${key}`);
    safe[key] = args[key] ?? false;
  }
  if (args.glob !== undefined) safe.glob = string(args, "glob", 256);
  return safe;
}

function prepareWebSearch(args: Record<string, unknown>): Record<string, unknown> {
  return { query: string(args, "query"), maxResults: number(args, "maxResults", 5, 5), timeoutMs: number(args, "timeoutMs", 15_000, 30_000) };
}

function prepareWebFetch(args: Record<string, unknown>): Record<string, unknown> {
  const base = publicUrl(args.url, number(args, "maxBytes", 65_536, 65_536));
  base.timeoutMs = number(args, "timeoutMs", 15_000, 30_000);
  const safe: Record<string, unknown> = { url: base.url, maxBytes: base.maxBytes, timeoutMs: base.timeoutMs };
  const mode = optionalEnum(args, "responseMode", ["readable", "raw"]);
  if (mode !== undefined) safe.responseMode = mode;
  const part = optionalEnum(args, "responsePart", ["full", "headers", "body"]);
  if (part !== undefined) safe.responsePart = part;
  return safe;
}

function prepareHttpFetch(args: Record<string, unknown>): Record<string, unknown> {
  return prepareWebFetch(args);
}

async function preparePdfRead(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const safe: Record<string, unknown> = { path: await confinedPath(root, args.path) };
  const first = optionalNumber(args, "firstPage", 500, 1);
  if (first !== undefined) safe.firstPage = first;
  const last = optionalNumber(args, "lastPage", 500, 1);
  if (last !== undefined) safe.lastPage = last;
  const pages = optionalNumber(args, "maxPages", 50, 1);
  if (pages !== undefined) safe.maxPages = pages;
  else safe.maxPages = 50;
  const chars = optionalNumber(args, "maxChars", 50_000, 1000);
  if (chars !== undefined) safe.maxChars = chars;
  if (safe.firstPage !== undefined && safe.lastPage !== undefined && (safe.lastPage as number) < (safe.firstPage as number)) throw new Error("lastPage precedes firstPage");
  return safe;
}

async function prepareImageView(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const hasPath = args.path !== undefined;
  const hasPaths = args.paths !== undefined;
  if (!hasPath && !hasPaths) throw new Error("image.view requires path or paths");
  const safe: Record<string, unknown> = {};
  if (hasPath) safe.path = await confinedPath(root, args.path);
  if (hasPaths) {
    const paths = stringList(args.paths, "paths", 1, 4, 4096);
    const confined: string[] = [];
    for (const entry of paths) confined.push(await confinedPath(root, entry));
    safe.paths = confined;
  }
  return safe;
}

async function prepareImageOcr(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const safe: Record<string, unknown> = { path: await confinedPath(root, args.path) };
  const lang = optionalString(args, "lang", 64);
  if (lang !== undefined) safe.lang = lang;
  const psm = optionalNumber(args, "psm", 13, 0);
  if (psm !== undefined) safe.psm = psm;
  const preprocess = optionalBoolean(args, "preprocess");
  if (preprocess !== undefined) safe.preprocess = preprocess;
  return safe;
}

function prepareToolCheck(args: Record<string, unknown>): Record<string, unknown> {
  return { tools: stringList(args.tools, "tools", 1, 20, 256) };
}

function prepareWordlistFind(args: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = { query: string(args, "query") };
  const expand = optionalBoolean(args, "expand");
  if (expand !== undefined) safe.expand = expand;
  return safe;
}

function prepareSkillLoad(args: Record<string, unknown>): Record<string, unknown> {
  return { name: string(args, "name", 256) };
}

function prepareSkillList(args: Record<string, unknown>): Record<string, unknown> {
  const query = optionalString(args, "query", 256);
  return query === undefined ? {} : { query };
}

export async function prepareReadOnlyCall(root: string, call: ToolCall): Promise<ToolCall> {
  const allowed = fields[call.name];
  if (!Object.hasOwn(fields, call.name) || !allowed) throw new Error(`Tool denied: ${call.name}`);
  if (!call.args || typeof call.args !== "object" || Array.isArray(call.args)) throw new Error("Invalid tool arguments");
  for (const key of Object.keys(call.args)) {
    if (!allowed.includes(key)) throw new Error(`Argument denied: ${call.name}.${key}`);
  }
  const args = call.args;
  switch (call.name) {
    case "fs.read": return { name: call.name, args: await prepareFsRead(root, args) };
    case "fs.list": return { name: call.name, args: await prepareFsList(root, args) };
    case "fs.search": return { name: call.name, args: await prepareFsSearch(root, args) };
    case "web.search": return { name: call.name, args: prepareWebSearch(args) };
    case "web.fetch": return { name: call.name, args: prepareWebFetch(args) };
    case "http.fetch": return { name: call.name, args: prepareHttpFetch(args) };
    case "pdf.read": return { name: call.name, args: await preparePdfRead(root, args) };
    case "image.view": return { name: call.name, args: await prepareImageView(root, args) };
    case "image.ocr": return { name: call.name, args: await prepareImageOcr(root, args) };
    case "sysinfo": return { name: call.name, args: {} };
    case "tool.check": return { name: call.name, args: prepareToolCheck(args) };
    case "wordlist.find": return { name: call.name, args: prepareWordlistFind(args) };
    case "skill.load": return { name: call.name, args: prepareSkillLoad(args) };
    case "skill.list": return { name: call.name, args: prepareSkillList(args) };
    case "shell.exec": return { name: call.name, args: await prepareShellExec(root, args) };
    default: throw new Error(`Tool denied: ${call.name}`);
  }
}

export type ReadOnlyRegistry = (call: ToolCall, options: ToolRunOptions) => Promise<ToolResult>;
const excluded = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target", "coverage", ".next", ".venv", "__pycache__"]);

async function confineViewPaths(root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const safe: Record<string, unknown> = { ...args };
  if (args.path !== undefined) safe.path = await confinedPath(root, args.path);
  if (args.paths !== undefined) {
    const confined: string[] = [];
    for (const entry of args.paths as string[]) confined.push(await confinedPath(root, entry));
    safe.paths = confined;
  }
  return safe;
}

export async function executeReadOnlyCall(root: string, call: ToolCall, execute: ReadOnlyRegistry, options: ToolRunOptions): Promise<ToolResult> {
  options.signal?.throwIfAborted();
  if (!Object.hasOwn(fields, call.name)) throw new Error(`Tool denied: ${call.name}`);
  if (call.name !== "fs.search") {
    let safe = call;
    if (call.name.startsWith("fs.") || call.name === "pdf.read" || call.name === "image.ocr") {
      safe = { ...call, args: { ...call.args, path: await confinedPath(root, call.args.path) } };
    } else if (call.name === "image.view") {
      safe = { ...call, args: await confineViewPaths(root, call.args) };
    }
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
