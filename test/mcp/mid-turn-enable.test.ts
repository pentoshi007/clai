import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpRuntime } from "../../src/mcp/runtime.js";
import { McpManager, type McpTransportFactory } from "../../src/mcp/manager.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../src/mcp/types.js";
import type { McpTransport } from "../../src/mcp/transport.js";

class TwoToolTransport implements McpTransport {
  readonly kind = "stdio" as const;
  start(): Promise<void> {
    return Promise.resolve();
  }
  request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (message.method === "initialize") {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "probe", version: "1" },
        },
      } as JsonRpcResponse);
    }
    if (message.method === "tools/list") {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            { name: "get_me", description: "who am i", inputSchema: { type: "object" } },
            { name: "list_commits", description: "commits", inputSchema: { type: "object" } },
          ],
        },
      } as JsonRpcResponse);
    }
    return Promise.resolve({ jsonrpc: "2.0", id: message.id, result: {} } as JsonRpcResponse);
  }
  notify(): Promise<void> {
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

const SERVER = "io.github.github/github-mcp-server";

async function readyRuntime(): Promise<McpRuntime> {
  const root = mkdtempSync(join(tmpdir(), "clai-mcp-turn-"));
  const workspaceFolder = join(root, "proj");
  const homeDir = join(root, "home");
  mkdirSync(workspaceFolder, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  writeFileSync(
    join(workspaceFolder, ".mcp.json"),
    JSON.stringify({ mcpServers: { [SERVER]: { command: "probe", args: [] } } }),
  );
  const factory: McpTransportFactory = () => new TwoToolTransport();
  const manager = new McpManager({
    discovery: {
      workspaceFolder,
      homeDir,
      env: { XDG_CONFIG_HOME: join(homeDir, ".config") },
      platform: "linux" as const,
    },
    transportFactory: factory,
  });
  const runtime = new McpRuntime({ manager });
  await runtime.start();
  await runtime.refresh();
  return runtime;
}

describe("enabling an MCP server mid-turn", () => {
  it("advertises the newly enabled tools for the rest of the same turn", async () => {
    const runtime = await readyRuntime();
    runtime.selectOff();
    const lease = runtime.beginTurn();
    expect(runtime.toolDefinitions()).toHaveLength(0);

    await runtime.agentEnable("io.github.github/github-mcp-server");

    const names = runtime.toolDefinitions().map((tool) => tool.name);
    expect(names).toContain("mcp.io.github.github/github-mcp-server.get_me");
    expect(names).toContain("mcp.io.github.github/github-mcp-server.list_commits");
    lease.release();
  });

  it("names the callable tools and tells the model not to enable again", async () => {
    const runtime = await readyRuntime();
    runtime.selectOff();
    const lease = runtime.beginTurn();
    const result = await runtime.agentEnable("io.github.github/github-mcp-server");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Enabled MCP servers");
    expect(result.output).toContain("Active tools: 2");
    expect(result.output).toContain("Callable now:");
    expect(result.output).toContain("mcp.io.github.github/github-mcp-server.get_me");
    expect(result.output).toContain("call one instead of enabling again");
    lease.release();
  });

  it("keeps the same guarantee for enable-all", async () => {
    const runtime = await readyRuntime();
    runtime.selectOff();
    const lease = runtime.beginTurn();
    const result = await runtime.agentEnable("all");
    expect(result.output).toContain("Enabled all live MCP servers.");
    expect(runtime.toolDefinitions().length).toBe(2);
    lease.release();
  });

  it("does not retract tools already advertised in the same turn when turned off", async () => {
    const runtime = await readyRuntime();
    const lease = runtime.beginTurn();
    await runtime.agentEnable("all");
    expect(runtime.toolDefinitions().length).toBe(2);
    const off = await runtime.agentEnable("off");
    expect(off.ok).toBe(true);
    expect(runtime.getState().selection).toEqual({ mode: "off" });
    expect(runtime.toolDefinitions().length).toBe(2);
    lease.release();
    expect(runtime.toolDefinitions()).toHaveLength(0);
  });

  it("reports an unknown server as a failure instead of silently succeeding", async () => {
    const runtime = await readyRuntime();
    const result = await runtime.agentEnable("not-a-server");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("not-a-server");
    expect(result.output.trim().length).toBeGreaterThan(0);
  });

  it("never returns empty output from any control tool", async () => {
    const runtime = await readyRuntime();
    const results = [
      await runtime.agentList(),
      await runtime.agentTools(),
      await runtime.agentEnable("all"),
      await runtime.agentEnable("off"),
      await runtime.agentConnect(""),
      await runtime.agentLogin(""),
    ];
    for (const result of results) {
      expect(result.output.trim().length).toBeGreaterThan(0);
    }
  });
});
