import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpManager } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpTransport } from "../../src/mcp/transport.js";
import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from "../../src/mcp/types.js";
import { reaRoot } from "../../src/rea/install.js";

export function seedRea(version = "6.7.0"): void {
  const root = reaRoot();
  const directory = join(root, "versions", version);
  mkdirSync(directory, { recursive: true });
  const entry = join(directory, "rea.mjs");
  writeFileSync(entry, "rea");
  writeFileSync(join(root, "current.json"), JSON.stringify({ version, directory, entry, node: process.execPath }));
}

export function reaTestRuntime(root: string): {
  runtime: McpRuntime;
  starts: string[];
  closes: string[];
  calls: JsonRpcRequest[];
} {
  const starts: string[] = [];
  const closes: string[] = [];
  const calls: JsonRpcRequest[] = [];
  class Transport implements McpTransport {
    readonly kind = "stdio" as const;
    constructor(private readonly name: string) {}
    async start(): Promise<void> { starts.push(this.name); }
    async request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
      let result: object = {};
      if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: this.name, version: "1" } };
      if (message.method === "tools/list") result = { tools: [
        { name: "inspect_go_binary", description: "Inspect embedded Go metadata", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, annotations: { readOnlyHint: true } },
        ...Array.from({ length: 150 }, (_, index) => ({ name: `analysis_${index}`, description: "Inspect an artifact facet", inputSchema: { type: "object", properties: { path: { type: "string" } } } })),
      ] };
      if (message.method === "tools/call") {
        calls.push(message);
        result = { content: [{ type: "text", text: "Evidence: bounded static inspection complete" }] };
      }
      return { jsonrpc: "2.0", id: message.id, result };
    }
    async notify(_message: JsonRpcNotification): Promise<void> {}
    async close(): Promise<void> { closes.push(this.name); }
    sessionId(): undefined { return undefined; }
    setProtocolVersion(): void {}
  }
  const runtime = new McpRuntime({ manager: new McpManager({
    discovery: { workspaceFolder: root, homeDir: join(root, "home"), env: {}, platform: "linux" },
    transportFactory: (definition) => new Transport(definition.name),
  }) });
  return { runtime, starts, closes, calls };
}
