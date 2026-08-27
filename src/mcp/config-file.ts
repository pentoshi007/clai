import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { safeCwd } from "../os/cwd.js";
import { parseJsonc } from "./discovery.js";
import { validateServerEntry } from "./validation.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

type JsonObject = Record<string, unknown>;

export interface McpServerSnippet {
  readonly name: string;
  readonly entry: JsonObject;
}

export type McpSnippetParseResult =
  | { readonly ok: true; readonly snippet: McpServerSnippet }
  | { readonly ok: false; readonly error: string };

export type McpConfigWriteResult =
  | {
      readonly ok: true;
      readonly path: string;
      readonly displayPath: string;
      readonly serverName: string;
      readonly replaced: boolean;
    }
  | { readonly ok: false; readonly error: string; readonly path: string; readonly displayPath: string };

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function looksLikeServer(value: unknown): boolean {
  const entry = asObject(value);
  return Boolean(
    entry &&
      (typeof entry.command === "string" ||
        typeof entry.url === "string" ||
        typeof entry.type === "string"),
  );
}

function candidateEntries(root: JsonObject): Array<readonly [string, unknown]> {
  const nested = asObject(root.mcp);
  const maps = [
    asObject(root.mcpServers),
    asObject(root.servers),
    nested ? asObject(nested.servers) : undefined,
    nested ? asObject(nested.mcpServers) : undefined,
  ];
  const entries: Array<readonly [string, unknown]> = [];
  for (const map of maps) {
    if (!map) continue;
    entries.push(...Object.entries(map));
  }
  if (entries.length > 0) return entries;
  return Object.entries(root).filter(([, value]) => looksLikeServer(value));
}

export function parseMcpServerSnippet(
  text: string,
  options: {
    readonly workspaceFolder?: string | undefined;
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  } = {},
): McpSnippetParseResult {
  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    return {
      ok: false,
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const root = asObject(parsed);
  if (!root) return { ok: false, error: "MCP server JSON must be an object" };

  let name: string | undefined;
  let entry: JsonObject | undefined;
  if (typeof root.name === "string") {
    name = root.name.trim();
    const { name: _name, ...rest } = root;
    entry = rest;
  } else {
    const candidates = candidateEntries(root);
    if (candidates.length !== 1) {
      return {
        ok: false,
        error:
          candidates.length === 0
            ? "include one named MCP server, for example {\"name\":\"docs\",\"command\":\"docs-server\"}"
            : "add one MCP server at a time",
      };
    }
    name = candidates[0]![0].trim();
    entry = asObject(candidates[0]![1]);
  }

  if (!name || !entry) {
    return { ok: false, error: "the MCP server name and definition are required" };
  }
  const validation = validateServerEntry(name, entry, {
    workspaceFolder: resolve(options.workspaceFolder ?? safeCwd()),
    env: options.env ?? process.env,
    inputs: new Map(),
  });
  if (!validation.ok) {
    return { ok: false, error: validation.errors.join("; ") };
  }
  return { ok: true, snippet: { name, entry } };
}

function claimServers(root: JsonObject): Map<string, JsonObject> {
  const servers = new Map<string, JsonObject>();
  const nested = asObject(root.mcp);
  const maps = [
    asObject(root.mcpServers),
    asObject(root.servers),
    nested ? asObject(nested.servers) : undefined,
    nested ? asObject(nested.mcpServers) : undefined,
  ];
  let claimedMap = false;
  for (const map of maps) {
    if (!map) continue;
    claimedMap = true;
    for (const [name, value] of Object.entries(map)) {
      const entry = asObject(value);
      if (entry && !servers.has(name)) servers.set(name, entry);
    }
  }
  if (!claimedMap) {
    for (const [name, value] of Object.entries(root)) {
      const entry = asObject(value);
      if (entry && looksLikeServer(entry)) servers.set(name, entry);
    }
  }
  return servers;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  const record = asObject(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.keys(record)
      .sort((a, b) => a.localeCompare(b))
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function canonicalRoot(root: JsonObject, servers: Map<string, JsonObject>): JsonObject {
  const out: JsonObject = { ...root };
  delete out.mcpServers;
  delete out.servers;
  const nested = asObject(root.mcp);
  const hasKnownServerMap = Boolean(
    asObject(root.mcpServers) ||
      asObject(root.servers) ||
      (nested && (asObject(nested.servers) || asObject(nested.mcpServers))),
  );
  if (!hasKnownServerMap) {
    for (const [key, value] of Object.entries(root)) {
      if (looksLikeServer(value)) delete out[key];
    }
  }
  if (nested) {
    const cleanNested: JsonObject = { ...nested };
    delete cleanNested.mcpServers;
    delete cleanNested.servers;
    if (Object.keys(cleanNested).length > 0) out.mcp = cleanNested;
    else delete out.mcp;
  }
  out.servers = Object.fromEntries(
    [...servers.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  return canonicalize(out) as JsonObject;
}

export function projectMcpConfigPath(workspaceFolder = safeCwd()): string {
  return join(resolve(workspaceFolder), ".clai", "mcp.json");
}

export function displayMcpConfigPath(path: string, workspaceFolder = safeCwd()): string {
  const shown = relative(resolve(workspaceFolder), path).replace(/\\/g, "/");
  return shown && !shown.startsWith("..") ? shown : path;
}

export async function writeProjectMcpServer(
  text: string,
  options: {
    readonly workspaceFolder?: string | undefined;
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  } = {},
): Promise<McpConfigWriteResult> {
  const workspaceFolder = resolve(options.workspaceFolder ?? safeCwd());
  const path = projectMcpConfigPath(workspaceFolder);
  const displayPath = displayMcpConfigPath(path, workspaceFolder);
  const parsed = parseMcpServerSnippet(text, {
    workspaceFolder,
    ...(options.env ? { env: options.env } : {}),
  });
  if (!parsed.ok) return { ok: false, error: parsed.error, path, displayPath };

  let root: JsonObject = {};
  try {
    const current = await readFile(path, "utf8");
    if (Buffer.byteLength(current, "utf8") > MAX_CONFIG_BYTES) {
      return { ok: false, error: "existing MCP config is larger than 1 MiB", path, displayPath };
    }
    const existing = asObject(parseJsonc(current));
    if (!existing) {
      return { ok: false, error: "existing MCP config must contain a JSON object", path, displayPath };
    }
    root = existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false,
        error: `could not read existing MCP config: ${error instanceof Error ? error.message : String(error)}`,
        path,
        displayPath,
      };
    }
  }

  const servers = claimServers(root);
  const replaced = servers.has(parsed.snippet.name);
  servers.set(parsed.snippet.name, parsed.snippet.entry);
  const body = `${JSON.stringify(canonicalRoot(root, servers), null, 2)}\n`;
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    return {
      ok: true,
      path,
      displayPath,
      serverName: parsed.snippet.name,
      replaced,
    };
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    return {
      ok: false,
      error: `could not write MCP config: ${error instanceof Error ? error.message : String(error)}`,
      path,
      displayPath,
    };
  }
}
