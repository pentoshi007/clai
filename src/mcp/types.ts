import type { ChatImage, JsonSchemaObject, RiskLevel } from "../types.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18" as const;

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;

export const MCP_CLIENT_NAME = "clai" as const;

export type McpTransportKind = "stdio" | "http" | "sse";

export interface McpStdioConfig {
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string | undefined;
}

export interface McpHttpConfig {
  readonly transport: "http" | "sse";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export type McpToolSelection = "all" | readonly string[];

export type McpConfigSourceKind =
  | "clai-env"
  | "clai-project"
  | "mcp-project"
  | "github-project"
  | "vscode-project"
  | "clai-user"
  | "copilot-user"
  | "claude-user"
  | "vscode-user";

export const MCP_SOURCE_PRECEDENCE: readonly McpConfigSourceKind[] = [
  "clai-env",
  "clai-project",
  "mcp-project",
  "github-project",
  "vscode-project",
  "clai-user",
  "copilot-user",
  "claude-user",
  "vscode-user",
] as const;

export const MCP_SOURCE_LABELS: Readonly<Record<McpConfigSourceKind, string>> = {
  "clai-env": "CLAI_MCP_CONFIG",
  "clai-project": ".clai/mcp.json (project)",
  "mcp-project": ".mcp.json (project)",
  "github-project": ".github/mcp.json (repo)",
  "vscode-project": ".vscode/mcp.json (VS Code compatibility)",
  "clai-user": "clai user MCP config",
  "copilot-user": "~/.copilot/mcp-config.json (user)",
  "claude-user": "Claude user config",
  "vscode-user": "VS Code user config (compatibility)",
} as const;

export interface McpConfigSource {
  readonly kind: McpConfigSourceKind;
  readonly path: string;
  readonly rank: number;
  readonly depth?: number | undefined;
}

export interface McpInputDefinition {
  readonly id: string;
  readonly type?: string | undefined;
  readonly description?: string | undefined;
  readonly default?: string | undefined;
  readonly password?: boolean | undefined;
}

export interface McpServerDefinition {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly disabled: boolean;
  readonly toolSelection: McpToolSelection;
  readonly source: McpConfigSource;
  readonly signature: string;
  readonly secretValues: readonly string[];
}

export interface McpShadowedServer {
  readonly name: string;
  readonly source: McpConfigSource;
  readonly shadowedBy: McpConfigSource;
}

export interface McpInvalidServer {
  readonly name: string;
  readonly source: McpConfigSource;
  readonly errors: readonly string[];
}

export interface McpDiscoveryResult {
  readonly servers: readonly McpServerDefinition[];
  readonly shadowed: readonly McpShadowedServer[];
  readonly invalid: readonly McpInvalidServer[];
  readonly sources: readonly McpConfigSource[];
  readonly warnings: readonly string[];
}

export interface McpDiscoveryOptions {
  readonly workspaceFolder?: string | undefined;
  readonly homeDir?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}

export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcErrorPayload {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly error: JsonRpcErrorPayload;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export interface McpServerInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpInitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: Readonly<Record<string, unknown>>;
  readonly serverInfo?: McpServerInfo | undefined;
  readonly instructions?: string | undefined;
}

export interface McpToolAnnotations {
  readonly title?: string | undefined;
  readonly readOnlyHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
  readonly idempotentHint?: boolean | undefined;
  readonly openWorldHint?: boolean | undefined;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly inputSchema?: Readonly<Record<string, unknown>> | undefined;
  readonly annotations?: McpToolAnnotations | undefined;
}

export interface McpToolMetadata {
  readonly canonicalName: string;
  readonly wireName: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly title?: string | undefined;
  readonly description: string;
  readonly inputSchema: JsonSchemaObject;
  readonly risk: RiskLevel;
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
  readonly annotations: McpToolAnnotations;
}

export interface McpNormalizedImage {
  readonly mediaType: string;
  readonly dataBase64: string;
}

export interface McpNormalizedResource {
  readonly uri: string;
  readonly mimeType?: string | undefined;
  readonly text?: string | undefined;
  readonly blobBase64?: string | undefined;
}

export interface McpNormalizedResult {
  readonly ok: boolean;
  readonly isError: boolean;
  readonly text: string;
  readonly images: readonly McpNormalizedImage[];
  readonly resources: readonly McpNormalizedResource[];
  readonly chatImages: readonly ChatImage[];
  readonly raw: unknown;
}

export type McpServerStatusKind =
  | "ready"
  | "degraded"
  | "disabled"
  | "error"
  | "connecting";

export interface McpServerStatus {
  readonly name: string;
  readonly status: McpServerStatusKind;
  readonly transport: McpTransportKind;
  readonly source: McpConfigSource;
  readonly toolCount: number;
  readonly signature: string;
  readonly detail?: string | undefined;
  readonly serverInfo?: McpServerInfo | undefined;
  readonly protocolVersion?: string | undefined;
}

export interface McpSnapshot {
  readonly createdAt: number;
  readonly statuses: readonly McpServerStatus[];
  readonly tools: readonly McpToolMetadata[];
  readonly toolsByCanonicalName: ReadonlyMap<string, McpToolMetadata>;
  readonly toolsByWireName: ReadonlyMap<string, McpToolMetadata>;
  readonly shadowed: readonly McpShadowedServer[];
  readonly invalid: readonly McpInvalidServer[];
}

export interface McpRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}
