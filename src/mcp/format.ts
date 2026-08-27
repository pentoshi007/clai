import type {
  McpDiscoveryResult,
  McpServerConfig,
  McpServerDefinition,
  McpServerStatus,
  McpServerStatusKind,
  McpSnapshot,
  McpToolMetadata,
} from "./types.js";

const SECRET_MASK = "***";

export function redactSecrets(text: string, secretValues: readonly string[]): string {
  let out = text;
  for (const secret of secretValues) {
    if (secret.length === 0) continue;
    out = out.split(secret).join(SECRET_MASK);
  }
  return out;
}

export interface DisplayServerConfig {
  readonly transport: McpServerConfig["transport"];
  readonly command?: string | undefined;
  readonly args?: readonly string[] | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export function redactServerConfig(definition: McpServerDefinition): DisplayServerConfig {
  const config = definition.config;
  const secrets = definition.secretValues;
  if (config.transport === "stdio") {
    const env: Record<string, string> = {};
    for (const key of Object.keys(config.env)) env[key] = SECRET_MASK;
    return {
      transport: "stdio",
      command: redactSecrets(config.command, secrets),
      args: config.args.map((arg) => redactSecrets(arg, secrets)),
      env,
      ...(config.cwd !== undefined ? { cwd: redactSecrets(config.cwd, secrets) } : {}),
    };
  }
  const headers: Record<string, string> = {};
  for (const key of Object.keys(config.headers)) headers[key] = SECRET_MASK;
  return {
    transport: config.transport,
    url: redactSecrets(config.url, secrets),
    headers,
  };
}

function statusSymbol(status: McpServerStatusKind): string {
  switch (status) {
    case "ready":
      return "ready";
    case "degraded":
      return "degraded";
    case "disabled":
      return "disabled";
    case "connecting":
      return "connecting";
    default:
      return "error";
  }
}

function riskLabel(tool: McpToolMetadata): string {
  if (tool.risk === "safe") return "safe";
  if (tool.destructive) return "confirm/destructive";
  return "confirm";
}

export function formatToolLine(tool: McpToolMetadata): string {
  const summary = tool.description.split("\n")[0]?.trim() ?? "";
  const trimmed = summary.length > 80 ? `${summary.slice(0, 77)}...` : summary;
  return `  ${tool.canonicalName} [${riskLabel(tool)}]${trimmed ? ` - ${trimmed}` : ""}`;
}

export function formatStatusLine(status: McpServerStatus): string {
  const info = status.serverInfo ? ` (${status.serverInfo.name} ${status.serverInfo.version})` : "";
  const detail = status.detail ? ` - ${status.detail}` : "";
  return `${statusSymbol(status.status)}  ${status.name}${info} [${status.transport} · ${status.source.kind}] tools=${status.toolCount} · ${status.source.path}${detail}`;
}

export function formatStatuses(statuses: readonly McpServerStatus[]): string {
  if (statuses.length === 0) return "No MCP servers configured.";
  return statuses.map(formatStatusLine).join("\n");
}

export function formatCatalog(snapshot: McpSnapshot): string {
  const lines: string[] = [];
  for (const status of snapshot.statuses) {
    lines.push(formatStatusLine(status));
    const tools = snapshot.tools.filter((tool) => tool.serverName === status.name);
    for (const tool of tools) lines.push(formatToolLine(tool));
  }
  if (snapshot.shadowed.length > 0) {
    lines.push("");
    lines.push("Shadowed servers:");
    for (const entry of snapshot.shadowed) {
      lines.push(`  ${entry.name} in ${entry.source.path} (shadowed by ${entry.shadowedBy.path})`);
    }
  }
  if (snapshot.invalid.length > 0) {
    lines.push("");
    lines.push("Invalid servers:");
    for (const entry of snapshot.invalid) {
      lines.push(`  ${entry.name} in ${entry.source.path}: ${entry.errors.join("; ")}`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "No MCP servers configured.";
}

export function formatDiscoverySummary(result: McpDiscoveryResult): string {
  const lines: string[] = [];
  lines.push(`Sources read: ${result.sources.length}`);
  for (const source of result.sources) {
    lines.push(`  [${source.kind}] ${source.path}`);
  }
  lines.push(`Servers: ${result.servers.length}`);
  for (const server of result.servers) {
    const flag = server.disabled ? " (disabled)" : "";
    lines.push(`  ${server.name}${flag} [${server.config.transport}] from ${server.source.kind}`);
  }
  if (result.shadowed.length > 0) {
    lines.push(`Shadowed: ${result.shadowed.length}`);
    for (const entry of result.shadowed) {
      lines.push(`  ${entry.name} (${entry.source.kind}) < ${entry.shadowedBy.kind}`);
    }
  }
  if (result.invalid.length > 0) {
    lines.push(`Invalid: ${result.invalid.length}`);
    for (const entry of result.invalid) {
      lines.push(`  ${entry.name}: ${entry.errors.join("; ")}`);
    }
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  return lines.join("\n");
}
