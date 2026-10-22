import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpManager, type McpTransportFactory } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpTransport } from "../../src/mcp/transport.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../src/mcp/types.js";
import { isClientOwnedToolName, normalizeBatchToolName } from "../../src/tools/registry.js";

const TOOLS: Readonly<Record<string, readonly { name: string; readOnly: boolean }[]>> = {
  fs: [{ name: "read", readOnly: true }],
  web: [{ name: "search", readOnly: true }],
  shell: [{ name: "exec", readOnly: false }],
  docs: [{ name: "lookup", readOnly: true }],
};

const calls: string[] = [];

class NamedTransport implements McpTransport {
  readonly kind = "stdio" as const;

  constructor(private readonly server: string) {}

  start(): Promise<void> {
    return Promise.resolve();
  }

  request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (message.method === "initialize") {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: this.server, version: "1.0.0" },
        },
      });
    }
    if (message.method === "tools/list") {
      const tools = (TOOLS[this.server] ?? []).map((tool) => ({
        name: tool.name,
        description: `${tool.name} on ${this.server}`,
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: tool.readOnly },
      }));
      return Promise.resolve({ jsonrpc: "2.0", id: message.id, result: { tools } });
    }
    if (message.method === "tools/call") {
      const params = message.params as { name?: string };
      calls.push(`${this.server}.${params.name ?? ""}`);
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `ran ${this.server}.${params.name}` }] },
      });
    }
    return Promise.resolve({ jsonrpc: "2.0", id: message.id, result: {} });
  }

  notify(_message: JsonRpcNotification): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  sessionId(): string | undefined {
    return undefined;
  }

  setProtocolVersion(): void {}
}

const factory: McpTransportFactory = (definition) => new NamedTransport(definition.name);

let root: string;
let runtime: McpRuntime;

beforeEach(async () => {
  calls.length = 0;
  root = mkdtempSync(join(tmpdir(), "clai-mcp-owned-"));
  const workspace = join(root, "project");
  const home = join(root, "home");
  mkdirSync(join(workspace, ".clai"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, ".clai", "mcp.json"),
    JSON.stringify({
      servers: Object.fromEntries(Object.keys(TOOLS).map((name) => [name, { command: name }])),
    }),
  );
  runtime = new McpRuntime({
    manager: new McpManager({
      discovery: {
        workspaceFolder: workspace,
        homeDir: home,
        env: { XDG_CONFIG_HOME: join(home, ".config") },
        platform: "linux",
      },
      transportFactory: factory,
    }),
  });
  await runtime.refresh();
  runtime.selectAll();
});

afterEach(async () => {
  await runtime.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("MCP tools that share a folded spelling with a built-in tool", () => {
  const COLLIDING = ["fs.read", "fs_read", "web.search", "web_search", "shell.exec", "shell_exec"];

  it("only collides with names the built-in registry owns", () => {
    for (const name of ["fs.read", "web.search", "shell.exec", "mcp.list", "rea.manage"]) {
      expect(isClientOwnedToolName(name)).toBe(true);
    }
    for (const name of ["read", "lookup", "mcp.fs.read", "mcp_fs_read"]) {
      expect(isClientOwnedToolName(name)).toBe(false);
    }
  });

  it.each(COLLIDING)("never claim the built-in %s", (name) => {
    expect(runtime.getTool(name)).toBeUndefined();
    expect(runtime.classify(name)).toBeUndefined();
    expect(runtime.isParallelSafe(name)).toBe(false);
    expect(runtime.canonicalizeToolName(name)).not.toMatch(/^mcp\./);
  });

  it("leaves batch name resolution on the built-in tool", () => {
    expect(normalizeBatchToolName("fs.read")).toBe("fs.read");
    expect(normalizeBatchToolName("fs_read")).toBe("fs.read");
    expect(normalizeBatchToolName("web_search")).toBe("web.search");
  });

  it("still resolves the MCP tools by their own names and unambiguous spellings", async () => {
    for (const name of ["mcp.fs.read", "mcp_fs_read", "read"]) {
      expect(runtime.getTool(name)?.canonicalName).toBe("mcp.fs.read");
    }
    expect(runtime.getTool("lookup")?.canonicalName).toBe("mcp.docs.lookup");
    expect(runtime.getTool("docs.lookup")?.canonicalName).toBe("mcp.docs.lookup");
    expect(runtime.classify("mcp.fs.read")?.level).toBe("safe");
    expect(runtime.classify("mcp.shell.exec")?.level).toBe("confirm");
    expect(runtime.isParallelSafe("mcp.web.search")).toBe(true);
    const result = await runtime.callTool("read", {});
    expect(result.ok).toBe(true);
    expect(calls).toEqual(["fs.read"]);
  });
});
