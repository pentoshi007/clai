import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { safeCwd } from "../os/cwd.js";
import { buildInputMap, type McpSubstitutionContext } from "./substitution.js";
import { validateServerEntry } from "./validation.js";
import {
  MCP_SOURCE_PRECEDENCE,
  type McpConfigSource,
  type McpConfigSourceKind,
  type McpDiscoveryOptions,
  type McpDiscoveryResult,
  type McpInputDefinition,
  type McpInvalidServer,
  type McpServerConfig,
  type McpServerDefinition,
  type McpShadowedServer,
  type McpToolSelection,
} from "./types.js";

function stripComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        if (next !== undefined) {
          out += next;
          i++;
        }
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(removeTrailingCommas(stripComments(text)));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function computeConfigSignature(
  config: McpServerConfig,
  toolSelection: McpToolSelection = "all",
): string {
  const selection = toolSelection === "all" ? "all" : [...toolSelection].sort();
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ config, tools: selection })))
    .digest("hex")
    .slice(0, 16);
}

function rankFor(kind: McpConfigSourceKind): number {
  const index = MCP_SOURCE_PRECEDENCE.indexOf(kind);
  return index === -1 ? MCP_SOURCE_PRECEDENCE.length : index;
}

function findRepoRoot(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function projectDirs(start: string, repoRoot: string | undefined): string[] {
  const dirs: string[] = [];
  let current = resolve(start);
  for (;;) {
    dirs.push(current);
    if (repoRoot !== undefined && current === repoRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    if (repoRoot === undefined) break;
    current = parent;
  }
  return dirs;
}

function vscodeUserDir(
  home: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === "win32") {
    const appData = env.APPDATA;
    const base = appData && appData.length > 0 ? appData : join(home, "AppData", "Roaming");
    return join(base, "Code", "User");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Code", "User");
  }
  const xdg = env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".config");
  return join(base, "Code", "User");
}

function buildSources(options: {
  workspaceFolder: string;
  homeDir: string;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
}): McpConfigSource[] {
  const { workspaceFolder, homeDir, platform, env } = options;
  const sources: McpConfigSource[] = [];

  const envList = env.CLAI_MCP_CONFIG;
  if (envList && envList.trim().length > 0) {
    for (const part of envList.split(delimiter)) {
      const trimmed = part.trim();
      if (trimmed.length === 0) continue;
      const path = isAbsolute(trimmed) ? trimmed : resolve(workspaceFolder, trimmed);
      sources.push({ kind: "clai-env", path, rank: rankFor("clai-env") });
    }
  }

  const repoRoot = findRepoRoot(workspaceFolder);
  projectDirs(workspaceFolder, repoRoot).forEach((dir, depth) => {
    sources.push({
      kind: "clai-project",
      path: join(dir, ".clai", "mcp.json"),
      rank: rankFor("clai-project"),
      depth,
    });
    sources.push({
      kind: "mcp-project",
      path: join(dir, ".mcp.json"),
      rank: rankFor("mcp-project"),
      depth,
    });
    if (repoRoot !== undefined && dir === repoRoot) {
      sources.push({
        kind: "github-project",
        path: join(dir, ".github", "mcp.json"),
        rank: rankFor("github-project"),
        depth,
      });
    }
    sources.push({
      kind: "vscode-project",
      path: join(dir, ".vscode", "mcp.json"),
      rank: rankFor("vscode-project"),
      depth,
    });
  });

  const platformConfigDir =
    platform === "win32"
      ? env.APPDATA && env.APPDATA.length > 0
        ? env.APPDATA
        : join(homeDir, "AppData", "Roaming")
      : platform === "darwin"
        ? join(homeDir, "Library", "Application Support")
        : env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length > 0
          ? env.XDG_CONFIG_HOME
          : join(homeDir, ".config");
  for (const path of [
    join(homeDir, ".clai", "mcp.json"),
    join(platformConfigDir, "clai", "mcp.json"),
  ]) {
    sources.push({ kind: "clai-user", path, rank: rankFor("clai-user") });
  }

  sources.push({
    kind: "copilot-user",
    path: join(homeDir, ".copilot", "mcp-config.json"),
    rank: rankFor("copilot-user"),
  });
  sources.push({
    kind: "claude-user",
    path: join(homeDir, ".claude.json"),
    rank: rankFor("claude-user"),
  });
  sources.push({
    kind: "claude-user",
    path: join(homeDir, ".claude", "settings.json"),
    rank: rankFor("claude-user"),
  });

  const userDir = vscodeUserDir(homeDir, platform, env);
  sources.push({
    kind: "vscode-user",
    path: join(userDir, "mcp.json"),
    rank: rankFor("vscode-user"),
  });
  sources.push({
    kind: "vscode-user",
    path: join(userDir, "settings.json"),
    rank: rankFor("vscode-user"),
  });

  return sources.sort((a, b) => {
    const rankDelta = a.rank - b.rank;
    if (rankDelta !== 0) return rankDelta;
    return (a.depth ?? 0) - (b.depth ?? 0);
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const RESERVED_MAP_KEYS: ReadonlySet<string> = new Set([
  "mcpServers",
  "servers",
  "mcp",
  "inputs",
  "projects",
  "version",
  "schemaVersion",
  "mcpVersion",
  "$schema",
  "schema",
]);

function looksLikeServer(value: unknown): boolean {
  const record = asObject(value);
  if (!record) return false;
  return (
    typeof record.command === "string" ||
    typeof record.url === "string" ||
    typeof record.type === "string"
  );
}

function supportsBareMap(kind: McpConfigSourceKind): boolean {
  return (
    kind === "clai-env" ||
    kind === "clai-project" ||
    kind === "mcp-project" ||
    kind === "github-project" ||
    kind === "clai-user" ||
    kind === "copilot-user"
  );
}

function readInputs(root: Record<string, unknown>): McpInputDefinition[] {
  const nested = asObject(root.mcp);
  const rawInputs = Array.isArray(root.inputs)
    ? root.inputs
    : nested && Array.isArray(nested.inputs)
      ? nested.inputs
      : [];
  const inputs: McpInputDefinition[] = [];
  for (const raw of rawInputs) {
    const record = asObject(raw);
    if (!record || typeof record.id !== "string") continue;
    const input: {
      id: string;
      type?: string;
      description?: string;
      default?: string;
      password?: boolean;
    } = { id: record.id };
    if (typeof record.type === "string") input.type = record.type;
    if (typeof record.description === "string") input.description = record.description;
    if (typeof record.default === "string") input.default = record.default;
    if (typeof record.password === "boolean") input.password = record.password;
    inputs.push(input);
  }
  return inputs;
}

function extractBlocks(
  json: unknown,
  kind: McpConfigSourceKind,
  workspaceFolder: string,
): { servers: Record<string, unknown>; inputs: McpInputDefinition[] } {
  const root = asObject(json) ?? {};
  const inputs = readInputs(root);
  const servers: Record<string, unknown> = {};
  const claim = (map: Record<string, unknown> | undefined): void => {
    if (!map) return;
    for (const [name, entry] of Object.entries(map)) {
      if (!(name in servers)) servers[name] = entry;
    }
  };

  if (kind === "claude-user") {
    const projects = asObject(root.projects);
    if (projects) {
      const project = asObject(projects[workspaceFolder]);
      if (project) claim(asObject(project.mcpServers));
    }
    claim(asObject(root.mcpServers));
    const nested = asObject(root.mcp);
    if (nested) claim(asObject(nested.mcpServers));
    return { servers, inputs };
  }

  claim(asObject(root.mcpServers));
  claim(asObject(root.servers));
  const nested = asObject(root.mcp);
  if (nested) {
    claim(asObject(nested.servers));
    claim(asObject(nested.mcpServers));
  }

  if (Object.keys(servers).length === 0 && supportsBareMap(kind)) {
    for (const [name, value] of Object.entries(root)) {
      if (RESERVED_MAP_KEYS.has(name)) continue;
      if (looksLikeServer(value)) servers[name] = value;
    }
  }

  return { servers, inputs };
}

export function discoverMcpServers(
  options: McpDiscoveryOptions = {},
): McpDiscoveryResult {
  const workspaceFolder = resolve(options.workspaceFolder ?? safeCwd());
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? env.CLAI_MCP_HOME ?? homedir();
  const platform = options.platform ?? process.platform;

  const servers: McpServerDefinition[] = [];
  const shadowed: McpShadowedServer[] = [];
  const invalid: McpInvalidServer[] = [];
  const readSources: McpConfigSource[] = [];
  const warnings: string[] = [];

  const claimedBy = new Map<string, McpConfigSource>();
  const seenPaths = new Set<string>();

  for (const source of buildSources({ workspaceFolder, homeDir, platform, env })) {
    if (seenPaths.has(source.path)) continue;
    if (!existsSync(source.path)) continue;
    seenPaths.add(source.path);
    readSources.push(source);

    let json: unknown;
    try {
      json = parseJsonc(readFileSync(source.path, "utf8"));
    } catch (error) {
      warnings.push(`Failed to parse ${source.path}: ${(error as Error).message}`);
      continue;
    }

    const { servers: rawServers, inputs } = extractBlocks(json, source.kind, workspaceFolder);
    const context: McpSubstitutionContext = {
      env,
      inputs: buildInputMap(inputs),
      workspaceFolder,
    };

    for (const [name, rawEntry] of Object.entries(rawServers)) {
      const winner = claimedBy.get(name);
      if (winner) {
        shadowed.push({ name, source, shadowedBy: winner });
        continue;
      }
      const validation = validateServerEntry(name, rawEntry, context);
      if (!validation.ok) {
        invalid.push({ name, source, errors: validation.errors });
        continue;
      }
      claimedBy.set(name, source);
      servers.push({
        name,
        config: validation.server.config,
        disabled: validation.server.disabled,
        toolSelection: validation.server.toolSelection,
        source,
        signature: computeConfigSignature(
          validation.server.config,
          validation.server.toolSelection,
        ),
        secretValues: validation.server.secretValues,
      });
    }
  }

  return { servers, shadowed, invalid, sources: readSources, warnings };
}
