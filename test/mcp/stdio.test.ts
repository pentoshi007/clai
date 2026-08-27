import { afterEach, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioTransport } from "../../src/mcp/transport-stdio.js";
import { McpClient } from "../../src/mcp/client.js";
import { McpTransportError } from "../../src/mcp/transport.js";
import { createRequest } from "../../src/mcp/jsonrpc.js";
import type { McpStdioConfig } from "../../src/mcp/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "mock-stdio-server.mjs");

const active: StdioTransport[] = [];

function makeTransport(overrides: Partial<McpStdioConfig> = {}, token?: string): StdioTransport {
  const config: McpStdioConfig = {
    transport: "stdio",
    command: process.execPath,
    args: [fixture],
    env: token !== undefined ? { MCP_TEST_TOKEN: token } : {},
    ...overrides,
  };
  const transport = new StdioTransport(config, { requestTimeoutMs: 5_000, closeGraceMs: 500 });
  active.push(transport);
  return transport;
}

afterEach(async () => {
  for (const transport of active.splice(0)) {
    await transport.close().catch(() => undefined);
  }
});

describe("stdio transport handshake and tool calls", () => {
  it("initializes, paginates tools, and maps risk from annotations", async () => {
    const client = new McpClient(makeTransport());
    const init = await client.initialize();
    expect(init.serverInfo?.name).toBe("mock-stdio");
    expect(init.protocolVersion).toBe("2025-06-18");

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "write_file"]);
  });

  it("calls a tool and normalizes text content", async () => {
    const client = new McpClient(makeTransport());
    await client.initialize();
    const result = await client.callTool("echo", { text: "hello" });
    expect(result.ok).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("echo: hello");
  });

  it("passes configured env into the spawned process", async () => {
    const client = new McpClient(makeTransport({}, "sekret-token"));
    await client.initialize();
    const result = await client.callTool("read_token", {});
    expect(result.text).toBe("token=sekret-token");
  });

  it("normalizes image content into chat images", async () => {
    const client = new McpClient(makeTransport());
    await client.initialize();
    const result = await client.callTool("image", {});
    expect(result.images).toEqual([{ mediaType: "image/png", dataBase64: "QUJD" }]);
    expect(result.chatImages[0]?.mediaType).toBe("image/png");
  });

  it("surfaces tool errors via isError", async () => {
    const client = new McpClient(makeTransport());
    await client.initialize();
    const result = await client.callTool("boom", {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.text).toBe("tool failed");
  });

  it("rejects requests after close", async () => {
    const client = new McpClient(makeTransport());
    await client.initialize();
    await client.close();
    await expect(client.callTool("echo", { text: "x" })).rejects.toBeInstanceOf(McpTransportError);
  });
});

describe("stdio transport timeout and cancellation", () => {
  function silentTransport(): StdioTransport {
    const config: McpStdioConfig = {
      transport: "stdio",
      command: process.execPath,
      args: ["-e", "process.stdin.resume()"],
      env: {},
    };
    const transport = new StdioTransport(config, { requestTimeoutMs: 200, closeGraceMs: 300 });
    active.push(transport);
    return transport;
  }

  it("times out when the server never responds", async () => {
    const transport = silentTransport();
    await transport.start();
    await expect(
      transport.request(createRequest(0, "initialize", {}), { timeoutMs: 150 }),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("cancels an in-flight request when the signal aborts", async () => {
    const transport = silentTransport();
    await transport.start();
    const controller = new AbortController();
    const pending = transport.request(createRequest(0, "initialize", {}), {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });
});
