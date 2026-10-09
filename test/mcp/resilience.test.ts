import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../../src/mcp/client.js";
import { McpManager } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import {
  McpTransportError,
  type McpTransport,
  type McpTransportHandlers,
} from "../../src/mcp/transport.js";
import type { JsonRpcRequest, JsonRpcResponse, McpRequestOptions } from "../../src/mcp/types.js";

const roots: string[] = [];
const managers: McpManager[] = [];
const runtimes: McpRuntime[] = [];

class FixtureTransport implements McpTransport {
  readonly kind = "http" as const;
  handlers: McpTransportHandlers | undefined;
  calls = 0;
  lists = 0;
  failure: McpTransportError | undefined;
  readOnly = true;
  session: string | undefined;
  cursors = false;
  tools = ["lookup"];
  options: McpRequestOptions[] = [];

  setHandlers(handlers: McpTransportHandlers): void {
    this.handlers = handlers;
  }
  start = async (): Promise<void> => undefined;
  notify = async (): Promise<void> => undefined;
  close = async (): Promise<void> => undefined;
  sessionId = (): string | undefined => this.session;
  setProtocolVersion = (): void => undefined;

  async request(
    request: JsonRpcRequest,
    options: McpRequestOptions = {},
  ): Promise<JsonRpcResponse> {
    if (request.method === "initialize")
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: { listChanged: true } },
        },
      };
    if (request.method === "tools/list") {
      this.lists++;
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: this.tools.map((name) => ({
            name,
            inputSchema: { type: "object", properties: {} },
            annotations: { readOnlyHint: this.readOnly },
          })),
          ...(this.cursors ? { nextCursor: "repeated" } : {}),
        },
      };
    }
    this.calls++;
    this.options.push(options);
    if (this.failure) throw this.failure;
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: "result" }] },
    };
  }
}

function manager(config: Record<string, unknown> = {}): {
  manager: McpManager;
  transports: FixtureTransport[];
} {
  const root = mkdtempSync(join(tmpdir(), "clai-mcp-recovery-"));
  roots.push(root);
  mkdirSync(join(root, ".clai"));
  writeFileSync(
    join(root, ".clai", "mcp.json"),
    JSON.stringify({
      servers: { docs: { url: "https://example.com/mcp", ...config } },
    }),
  );
  const transports: FixtureTransport[] = [];
  const instance = new McpManager({
    discovery: {
      workspaceFolder: root,
      homeDir: root,
      env: { CLAI_MCP_CONFIG: join(root, ".clai", "mcp.json") },
    },
    transportFactory: () => {
      const transport = new FixtureTransport();
      if (config.mutating) transport.readOnly = false;
      transports.push(transport);
      return transport;
    },
  });
  managers.push(instance);
  return { manager: instance, transports };
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.closeAll()));
  await Promise.all(managers.splice(0).map((manager) => manager.closeAll()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP connection recovery", () => {
  it("shares one reconnect across concurrent read-only failures", async () => {
    const setup = manager({ timeoutMs: 2_000 });
    await setup.manager.refresh();
    setup.transports[0]!.failure = new McpTransportError("closed", "connection lost");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => setup.manager.callTool("mcp.docs.lookup", {})),
    );
    expect(results.every((result) => result.text === "result")).toBe(true);
    expect(setup.transports).toHaveLength(2);
    expect(setup.transports[1]!.calls).toBe(5);
    expect(setup.transports[1]!.options.every((options) => options.timeoutMs! <= 2_000)).toBe(true);
  });

  it("does not replay an ambiguous mutating call", async () => {
    const setup = manager({ mutating: true });
    await setup.manager.refresh();
    setup.transports[0]!.failure = new McpTransportError(
      "network",
      "response lost after execution",
    );
    await expect(setup.manager.callTool("mcp.docs.lookup", {})).rejects.toMatchObject({
      kind: "network",
    });
    expect(setup.transports.reduce((count, transport) => count + transport.calls, 0)).toBe(1);
    expect(setup.transports).toHaveLength(2);
    expect((await setup.manager.callTool("mcp.docs.lookup", {})).text).toBe("result");
  });

  it("reinitializes an expired HTTP session before safely retrying its rejected call", async () => {
    const setup = manager({ mutating: true });
    await setup.manager.refresh();
    setup.transports[0]!.session = "expired";
    setup.transports[0]!.failure = new McpTransportError("network", "session expired", 404);
    expect((await setup.manager.callTool("mcp.docs.lookup", {})).text).toBe("result");
    expect(setup.transports).toHaveLength(2);
    expect(setup.transports[1]!.calls).toBe(1);
  });

  it.each(["timeout", "cancelled"] as const)("does not reconnect after a %s", async (kind) => {
    const setup = manager();
    await setup.manager.refresh();
    setup.transports[0]!.failure = new McpTransportError(kind, "stopped waiting");
    await expect(setup.manager.callTool("mcp.docs.lookup", {})).rejects.toMatchObject({ kind });
    expect(setup.transports).toHaveLength(1);
  });

  it("responds to server pings and workspace root requests", async () => {
    const setup = manager();
    await setup.manager.refresh();
    const handlers = setup.transports[0]!.handlers!;
    expect(await handlers.request({ jsonrpc: "2.0", id: "ping", method: "ping" })).toEqual({
      jsonrpc: "2.0",
      id: "ping",
      result: {},
    });
    const response = await handlers.request({
      jsonrpc: "2.0",
      id: "roots",
      method: "roots/list",
    });
    expect(response).toMatchObject({
      result: {
        roots: [{ uri: expect.stringContaining("clai-mcp-recovery-") }],
      },
    });
    expect(
      await handlers.request({
        jsonrpc: "2.0",
        id: "sampling",
        method: "sampling/createMessage",
      }),
    ).toMatchObject({ error: { code: -32601 } });
  });
});

describe("MCP tool change notifications", () => {
  it("keeps a notification received while the previous catalog is still loading", async () => {
    const setup = manager();
    const runtime = new McpRuntime({ manager: setup.manager });
    runtimes.push(runtime);
    await runtime.start();
    runtime.selectAll();
    const transport = setup.transports[0]!;
    const original = transport.request.bind(transport);
    let release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(transport, "request").mockImplementationOnce(async (request, options) => {
      const response = await original(request, options);
      await waiting;
      return response;
    });
    transport.tools.push("first_tool");
    transport.handlers!.notification({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    await vi.waitFor(() => expect(transport.lists).toBe(2));
    transport.tools.push("second_tool");
    transport.handlers!.notification({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    release!();
    await vi.waitFor(() => expect(runtime.getState().activeToolCount).toBe(3));
    expect(transport.lists).toBe(3);
    expect(setup.transports).toHaveLength(1);
  });

  it("updates the live catalog without reconnecting or changing an in-flight lease", async () => {
    const setup = manager();
    const runtime = new McpRuntime({ manager: setup.manager });
    runtimes.push(runtime);
    await runtime.start();
    runtime.selectAll();
    const lease = runtime.beginTurn();
    const before = runtime.toolDefinitions();
    setup.transports[0]!.tools.push("new_tool");
    for (let index = 0; index < 10; index++)
      setup.transports[0]!.handlers!.notification({
        jsonrpc: "2.0",
        method: "notifications/tools/list_changed",
      });
    await vi.waitFor(() => expect(runtime.getState().activeToolCount).toBe(2));
    expect(setup.transports).toHaveLength(1);
    expect(setup.transports[0]!.lists).toBe(2);
    expect(runtime.toolDefinitions()).toEqual(before);
    lease.release();
    expect(runtime.toolDefinitions().map((tool) => tool.name)).toEqual([
      "mcp.docs.lookup",
      "mcp.docs.new_tool",
    ]);
  });

  it("requires a new turn when safety annotations change under a pinned tool", async () => {
    const setup = manager();
    const runtime = new McpRuntime({ manager: setup.manager });
    runtimes.push(runtime);
    await runtime.start();
    runtime.selectAll();
    const lease = runtime.beginTurn();
    setup.transports[0]!.readOnly = false;
    setup.transports[0]!.handlers!.notification({
      jsonrpc: "2.0",
      method: "notifications/tools/list_changed",
    });
    await vi.waitFor(() => expect(runtime.getState().snapshot.tools[0]!.readOnly).toBe(false));
    expect(await runtime.callTool("mcp.docs.lookup", {})).toMatchObject({
      ok: false,
      output: expect.stringContaining("changed during this turn"),
    });
    expect(setup.transports[0]!.calls).toBe(0);
    lease.release();
    expect(runtime.classify("mcp.docs.lookup")?.level).toBe("confirm");
  });

  it("rejects repeated pagination cursors instead of returning a partial catalog", async () => {
    const transport = new FixtureTransport();
    transport.cursors = true;
    const client = new McpClient(transport);
    await client.initialize();
    await expect(client.listTools()).rejects.toMatchObject({
      kind: "protocol",
    });
    expect(transport.lists).toBe(2);
    await client.close();
  });

  it("keeps one deadline across all pages of a slow catalog", async () => {
    const transport = new FixtureTransport();
    const client = new McpClient(transport);
    await client.initialize();
    vi.spyOn(transport, "request").mockImplementation(async (request) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      return {
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [], nextCursor: String(request.params?.cursor ?? "first") + "-next" },
      };
    });
    await expect(client.listTools({ timeoutMs: 30 })).rejects.toMatchObject({ kind: "timeout" });
    await client.close();
  });
});
