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
import { classifyToolCall } from "../../src/safety/classifier.js";
import {
  normalizeBatchToolName,
  runToolCall,
  unknownToolErrorMessage,
} from "../../src/tools/registry.js";

const calls: { name: string; args: Record<string, unknown> }[] = [];

class DocsTransport implements McpTransport {
  readonly kind = "http" as const;

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
          serverInfo: { name: "context7", version: "1" },
        },
      });
    }
    if (message.method === "tools/list") {
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "resolve-library-id",
              description: "Resolve a package name to a library id",
              inputSchema: {
                type: "object",
                properties: { libraryName: { type: "string" } },
                required: ["libraryName"],
              },
              annotations: { readOnlyHint: true },
            },
            {
              name: "get-library-docs",
              description: "Fetch documentation for a library id",
              inputSchema: {
                type: "object",
                properties: { context7CompatibleLibraryID: { type: "string" } },
              },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
    }
    if (message.method === "tools/call") {
      const params = message.params as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      calls.push({ name: params.name ?? "", args: params.arguments ?? {} });
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `ran ${params.name}` }] },
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

const factory: McpTransportFactory = () => new DocsTransport();

let root: string;
let workspace: string;
let home: string;
let runtime: McpRuntime;

async function ready(): Promise<McpRuntime> {
  const created = new McpRuntime({
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
  await created.refresh();
  created.selectServer("context7");
  return created;
}

beforeEach(async () => {
  calls.length = 0;
  root = mkdtempSync(join(tmpdir(), "clai-mcp-dispatch-"));
  workspace = join(root, "project");
  home = join(root, "home");
  mkdirSync(join(workspace, ".clai"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, ".clai", "mcp.json"),
    JSON.stringify({ servers: { context7: { url: "https://mcp.example/mcp" } } }),
  );
  runtime = await ready();
});

afterEach(async () => {
  await runtime.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("MCP dispatch through the static tool path", () => {
  it("runs a hyphenated MCP tool instead of dead-ending on Unknown tool", async () => {
    const result = await runToolCall({
      name: "mcp.context7.resolve-library-id",
      args: { libraryName: "next.js" },
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain("ran resolve-library-id");
    expect(calls).toEqual([
      { name: "resolve-library-id", args: { libraryName: "next.js" } },
    ]);
  });

  it("resolves underscored and server-only spellings of a live tool", async () => {
    expect(runtime.canonicalizeToolName("mcp_context7_resolve_library_id")).toBe(
      "mcp.context7.resolve-library-id",
    );
    expect(runtime.canonicalizeToolName("context7.get-library-docs")).toBe(
      "mcp.context7.get-library-docs",
    );
    const result = await runToolCall({
      name: "mcp_context7_resolve_library_id",
      args: { libraryName: "react" },
    });
    expect(result.ok).toBe(true);
    expect(calls[0]?.name).toBe("resolve-library-id");
  });

  it("accepts MCP children inside tool.batch and keeps read-only batches safe", async () => {
    expect(normalizeBatchToolName("mcp_context7_get_library_docs")).toBe(
      "mcp.context7.get-library-docs",
    );
    expect(
      classifyToolCall({ name: "mcp.context7.resolve-library-id", args: {} }).level,
    ).toBe("safe");
    const batch = classifyToolCall({
      name: "tool.batch",
      args: {
        calls: [
          { name: "mcp.context7.resolve-library-id", args: { libraryName: "vite" } },
          { name: "fs.list", args: { path: "." } },
        ],
      },
    });
    expect(batch.level).toBe("safe");

    const result = await runToolCall({
      name: "tool.batch",
      args: {
        calls: [
          { name: "mcp.context7.resolve-library-id", args: { libraryName: "vite" } },
          { name: "mcp.context7.get-library-docs", args: { context7CompatibleLibraryID: "/vite" } },
        ],
      },
    });
    expect(result.ok).toBe(true);
    expect(calls.map((entry) => entry.name).sort()).toEqual([
      "get-library-docs",
      "resolve-library-id",
    ]);
  });

  it("keeps a turn's advertised tools callable after the selection changes", async () => {
    const advertised = runtime.toolNames();
    expect(advertised).toContain("mcp.context7.resolve-library-id");

    const lease = runtime.beginTurn();
    runtime.selectOff();
    expect(runtime.getState().selection).toEqual({ mode: "off" });
    expect(runtime.toolNames()).toEqual(advertised);

    const result = await runToolCall({
      name: "mcp.context7.resolve-library-id",
      args: { libraryName: "svelte" },
    });
    expect(result.ok).toBe(true);

    lease.release();
    expect(runtime.toolNames()).toEqual([]);
  });

  it("explains an inactive MCP tool instead of listing only built-in tools", async () => {
    runtime.selectOff();
    const result = await runToolCall({
      name: "mcp.context7.resolve-library-id",
      args: { libraryName: "svelte" },
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("@mcp:context7");
    expect(result.output).not.toContain("Unknown tool");
    expect(calls).toEqual([]);

    const missing = await runToolCall({
      name: "mcp.context7.does-not-exist",
      args: {},
    });
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain("mcp.context7.does-not-exist");
  });

  it("lists active MCP tools in the unknown-tool message", () => {
    const message = unknownToolErrorMessage("fs.reed");
    expect(message).toContain("mcp.context7.resolve-library-id");
    expect(message).toContain("fs.read");
  });
});
