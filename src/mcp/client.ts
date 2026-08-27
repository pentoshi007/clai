import { VERSION } from "../version.generated.js";
import { createNotification, createRequest, resultOrThrow } from "./jsonrpc.js";
import { normalizeToolResult, parseToolDescriptor } from "./results.js";
import type { McpTransport } from "./transport.js";
import { McpTransportError } from "./transport.js";
import {
  MCP_CLIENT_NAME,
  MCP_PROTOCOL_VERSION,
  type McpInitializeResult,
  type McpNormalizedResult,
  type McpRequestOptions,
  type McpServerInfo,
  type McpToolDescriptor,
} from "./types.js";

const MAX_TOOL_PAGES = 100;

export interface McpClientOptions {
  readonly clientName?: string | undefined;
  readonly clientVersion?: string | undefined;
  readonly protocolVersion?: string | undefined;
  readonly capabilities?: Readonly<Record<string, unknown>> | undefined;
}

export class McpClient {
  private initialized = false;
  private serverProtocolVersion: string | undefined;
  private serverInfo: McpServerInfo | undefined;
  private serverCapabilities: Readonly<Record<string, unknown>> = {};

  constructor(
    private readonly transport: McpTransport,
    private readonly options: McpClientOptions = {},
  ) {}

  getServerInfo(): McpServerInfo | undefined {
    return this.serverInfo;
  }

  getProtocolVersion(): string | undefined {
    return this.serverProtocolVersion;
  }

  getCapabilities(): Readonly<Record<string, unknown>> {
    return this.serverCapabilities;
  }

  async initialize(options: McpRequestOptions = {}): Promise<McpInitializeResult> {
    await this.transport.start(options);
    const protocolVersion = this.options.protocolVersion ?? MCP_PROTOCOL_VERSION;
    const params = {
      protocolVersion,
      capabilities: this.options.capabilities ?? {},
      clientInfo: {
        name: this.options.clientName ?? MCP_CLIENT_NAME,
        version: this.options.clientVersion ?? VERSION,
      },
    };
    const response = await this.transport.request(createRequest(0, "initialize", params), options);
    const result = resultOrThrow(response);
    const parsed = this.parseInitialize(result);
    this.serverProtocolVersion = parsed.protocolVersion;
    this.serverCapabilities = parsed.capabilities;
    if (parsed.serverInfo) this.serverInfo = parsed.serverInfo;
    this.transport.setProtocolVersion(parsed.protocolVersion);
    await this.transport.notify(createNotification("notifications/initialized"), options);
    this.initialized = true;
    return parsed;
  }

  private parseInitialize(result: unknown): McpInitializeResult {
    if (typeof result !== "object" || result === null) {
      throw new McpTransportError("protocol", "MCP initialize returned no result object.");
    }
    const record = result as Record<string, unknown>;
    const protocolVersion =
      typeof record.protocolVersion === "string"
        ? record.protocolVersion
        : MCP_PROTOCOL_VERSION;
    const capabilities =
      typeof record.capabilities === "object" && record.capabilities !== null
        ? (record.capabilities as Record<string, unknown>)
        : {};
    const parsed: {
      protocolVersion: string;
      capabilities: Record<string, unknown>;
      serverInfo?: McpServerInfo;
      instructions?: string;
    } = { protocolVersion, capabilities };
    if (typeof record.serverInfo === "object" && record.serverInfo !== null) {
      const info = record.serverInfo as Record<string, unknown>;
      parsed.serverInfo = {
        name: typeof info.name === "string" ? info.name : "unknown",
        version: typeof info.version === "string" ? info.version : "0.0.0",
      };
    }
    if (typeof record.instructions === "string") parsed.instructions = record.instructions;
    return parsed;
  }

  async listTools(options: McpRequestOptions = {}): Promise<McpToolDescriptor[]> {
    this.assertInitialized();
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const params = cursor === undefined ? undefined : { cursor };
      const response = await this.transport.request(
        createRequest(0, "tools/list", params),
        options,
      );
      const result = resultOrThrow(response);
      const record =
        typeof result === "object" && result !== null
          ? (result as Record<string, unknown>)
          : {};
      const rawTools = Array.isArray(record.tools) ? record.tools : [];
      for (const entry of rawTools) {
        const descriptor = parseToolDescriptor(entry);
        if (descriptor) tools.push(descriptor);
      }
      const nextCursor = record.nextCursor;
      if (typeof nextCursor === "string" && nextCursor.length > 0) {
        cursor = nextCursor;
      } else {
        break;
      }
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<McpNormalizedResult> {
    this.assertInitialized();
    const response = await this.transport.request(
      createRequest(0, "tools/call", { name, arguments: args }),
      options,
    );
    const result = resultOrThrow(response);
    return normalizeToolResult(result);
  }

  async ping(options: McpRequestOptions = {}): Promise<void> {
    const response = await this.transport.request(createRequest(0, "ping"), options);
    resultOrThrow(response);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new McpTransportError("protocol", "MCP client used before initialize().");
    }
  }
}
