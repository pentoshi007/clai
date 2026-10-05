import { isAbsolute, resolve } from "node:path";
import { TOOL_DEFINITIONS } from "../../tools/definitions.js";
import type { ToolRunOptions } from "../../tools/tool-types.js";
import type { ToolCall, ToolDefinition, ToolResult } from "../../types.js";
import { FS_READ_OPTION_KEYS } from "../../tools/fs/read-input.js";
import { boundFsReadOutput, isFsReadMultiOutput } from "../../tools/fs/read-sections.js";

export const TOOL_OUTPUT_LIMIT = 12_000;

const fields: Record<string, readonly string[]> = {
  "fs.read": ["path", ...FS_READ_OPTION_KEYS, "files"],
  "web.search": ["query", "maxResults", "timeoutMs"],
  "web.fetch": ["url", "maxBytes", "timeoutMs", "responseMode", "responsePart"],
  "http.fetch": ["url", "maxBytes", "timeoutMs", "responseMode", "responsePart"],
  "pdf.read": ["path", "firstPage", "lastPage", "maxPages", "maxChars"],
  "image.view": ["path", "paths"],
  "image.ocr": ["path", "lang", "psm", "preprocess"],
  "skill.load": ["name"],
  "skill.list": ["query"],
  "shell.exec": ["command", "cwd", "timeoutMs"],
};

const descriptions: Record<string, string> = {
  "fs.read": 'Read one text file/directory: {"path":"src/app.ts","offset":1,"limit":80}. Optional 1–6 necessary known files: {"files":[{"path":"src/app.ts","limit":80},{"path":"src/config.ts","pattern":"export","context":2}]}. Use exactly one of path or files; filters belong directly inside each file entry in files mode. Lines are 1-indexed; pattern is a non-empty JS regex. Follow each file’s status and hasMore/clipping; retry only needed failed/unfinished reads. Use a single path when sufficient.',
  "web.search": "Search the web for current information.",
  "web.fetch": "Fetch a public URL as readable text.",
  "http.fetch": "GET-only HTTP evidence for public targets.",
  "pdf.read": "Extract text from a PDF with bounded paging.",
  "image.view": "View image bytes for a file.",
  "image.ocr": "OCR text from an image file.",
  "skill.load": "Read one skill's instructions.",
  "skill.list": "List installed skills.",
  "shell.exec": "Shell command execution for search and inspection.",
};

export const READ_ONLY_TOOL_NAMES = new Set(Object.keys(fields));

export function isSubagentBlockedTool(name: string): boolean {
  return !READ_ONLY_TOOL_NAMES.has(name);
}

function withoutSchemaDescriptions(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutSchemaDescriptions);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => key !== "description")
    .map(([key, value]) => [key, withoutSchemaDescriptions(value)]));
}

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
          if (tool.name === "fs.read") return [key, withoutSchemaDescriptions(schema)];
          const { description: _dropped, ...rest } = schema as Record<string, unknown>;
          return [key, rest];
        })),
      additionalProperties: false,
    },
  }));

export function boundedOutput(text: string): string {
  if (isFsReadMultiOutput(text)) return boundFsReadOutput(text, TOOL_OUTPUT_LIMIT);
  const suffix = "\n[Output truncated; narrow the query or page the file. Coverage is incomplete.]";
  return text.length > TOOL_OUTPUT_LIMIT
    ? text.slice(0, TOOL_OUTPUT_LIMIT - suffix.length) + suffix
    : text;
}

export async function confinedPath(root: string, value: unknown = "."): Promise<string> {
  const p = typeof value === "string" && value.trim() ? value.trim() : ".";
  return isAbsolute(p) ? resolve(p) : resolve(root, p);
}

function prepareFsRead(root: string, args: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(args.files)) {
    return { ...args, files: args.files.map((file) => file && typeof file === "object" && !Array.isArray(file)
      ? prepareFsReadFile(root, file as Record<string, unknown>)
      : file) };
  }
  return prepareFsReadFile(root, args);
}

function prepareFsReadFile(root: string, args: Record<string, unknown>): Record<string, unknown> {
  const rawPath = typeof args.path === "string" && args.path.trim() ? args.path : undefined;
  const path = rawPath ? (isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath)) : args.path;
  const rawMaxBytes = typeof args.maxBytes === "string" && args.maxBytes.trim() ? Number(args.maxBytes) : args.maxBytes;
  const maxBytes = typeof rawMaxBytes === "number" && Number.isFinite(rawMaxBytes)
    ? Math.min(rawMaxBytes, TOOL_OUTPUT_LIMIT)
    : args.maxBytes ?? TOOL_OUTPUT_LIMIT;
  const safe: Record<string, unknown> = { ...args, path, maxBytes };
  const limit = typeof args.limit === "string" && args.limit.trim() ? Number(args.limit) : args.limit;
  if (typeof limit === "number" && Number.isFinite(limit)) safe.limit = Math.min(Math.max(1, limit), 300);
  return safe;
}

function prepareShellExec(root: string, args: Record<string, unknown>): Record<string, unknown> {
  const raw = typeof args.command === "string" ? args.command.trim() : "";
  if (!raw) throw new Error("Invalid command");
  const rawCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : "";
  const cwd = rawCwd ? (isAbsolute(rawCwd) ? resolve(rawCwd) : resolve(root, rawCwd)) : root;
  const timeoutMs = typeof args.timeoutMs === "number" && args.timeoutMs > 0
    ? Math.min(args.timeoutMs, 60_000)
    : 30_000;
  return { ...args, command: raw, cwd, timeoutMs, background: "never" };
}

export async function prepareReadOnlyCall(root: string, call: ToolCall): Promise<ToolCall> {
  if (!READ_ONLY_TOOL_NAMES.has(call.name)) {
    throw new Error(`Tool denied: ${call.name}`);
  }
  const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? { ...call.args } : {};
  switch (call.name) {
    case "fs.read": return { name: call.name, args: prepareFsRead(root, args) };
    case "shell.exec": return { name: call.name, args: prepareShellExec(root, args) };
    default: {
      if (typeof args.path === "string" && args.path.trim()) {
        args.path = isAbsolute(args.path) ? resolve(args.path) : resolve(root, args.path);
      }
      if (Array.isArray(args.paths)) {
        args.paths = args.paths.map((p) => typeof p === "string" && p.trim() ? (isAbsolute(p) ? resolve(p) : resolve(root, p)) : p);
      }
      return { name: call.name, args };
    }
  }
}

export type ReadOnlyRegistry = (call: ToolCall, options: ToolRunOptions) => Promise<ToolResult>;

export async function executeReadOnlyCall(root: string, call: ToolCall, execute: ReadOnlyRegistry, options: ToolRunOptions): Promise<ToolResult> {
  options.signal?.throwIfAborted();
  if (!READ_ONLY_TOOL_NAMES.has(call.name)) {
    throw new Error(`Tool denied: ${call.name}`);
  }
  let safe = call;
  if (call.args && typeof call.args === "object" && !Array.isArray(call.args)) {
    const args = { ...call.args };
    if (call.name === "fs.read") {
      safe = { ...call, args: prepareFsRead(root, args) };
    } else {
      if (typeof args.path === "string" && args.path.trim()) {
        args.path = isAbsolute(args.path) ? resolve(args.path) : resolve(root, args.path);
      }
      if (Array.isArray(args.paths)) {
        args.paths = args.paths.map((p) => typeof p === "string" && p.trim() ? (isAbsolute(p) ? resolve(p) : resolve(root, p)) : p);
      }
      safe = { ...call, args };
    }
  }
  options.signal?.throwIfAborted();
  const result = await execute(safe, options);
  options.signal?.throwIfAborted();
  return { ...result, output: boundedOutput(result.output) };
}
