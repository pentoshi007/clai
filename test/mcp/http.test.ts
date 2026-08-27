import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import {
  LegacySseTransport,
  StreamableHttpTransport,
} from "../../src/mcp/transport-http.js";
import { McpClient } from "../../src/mcp/client.js";
import { createRequest } from "../../src/mcp/jsonrpc.js";
import type { McpHttpConfig } from "../../src/mcp/types.js";

const servers: Server[] = [];

function listen(server: Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
  });
}

function sseData(res: ServerResponse, message: unknown): void {
  res.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function startStreamableServer(): Promise<string> {
  const server = createServer(async (req, res) => {
    if (req.method === "DELETE") {
      res.statusCode = 200;
      res.end();
      return;
    }
    const body = await readBody(req);
    const message = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const method = message.method;
    const id = message.id;
    const session = req.headers["mcp-session-id"];
    const protocol = req.headers["mcp-protocol-version"];

    if (method === "initialize") {
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "sess-42");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "http-mock", version: "9.9.9" },
          },
        }),
      );
      return;
    }
    if (method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (method === "big") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ jsonrpc: "2.0", id, result: { blob: "x".repeat(5000) } }),
      );
      return;
    }
    if (method === "slow") {
      setTimeout(() => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
      }, 1_000);
      return;
    }
    if (session !== "sess-42") {
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: -32001, message: "missing session" },
        }),
      );
      return;
    }
    if (method === "tools/list") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write(": keep-alive\n\n");
      sseData(res, {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "ping-tool",
              description: "Ping",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
      res.end();
      return;
    }
    if (method === "tools/call") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `pong ${protocol ?? ""}` }] },
        }),
      );
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "nope" } }));
  });
  return listen(server);
}

describe("streamable HTTP transport", () => {
  it("handshakes over JSON, captures the session id, and reads SSE tool lists", async () => {
    const url = await startStreamableServer();
    const config: McpHttpConfig = { transport: "http", url, headers: {} };
    const transport = new StreamableHttpTransport(config);
    const client = new McpClient(transport);

    const init = await client.initialize();
    expect(init.serverInfo?.name).toBe("http-mock");
    expect(transport.sessionId()).toBe("sess-42");

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["ping-tool"]);
  });

  it("propagates session and protocol headers to JSON tool calls", async () => {
    const url = await startStreamableServer();
    const client = new McpClient(new StreamableHttpTransport({ transport: "http", url, headers: {} }));
    await client.initialize();
    const result = await client.callTool("ping-tool", {});
    expect(result.text).toBe("pong 2025-06-18");
  });

  it("enforces a bounded response body", async () => {
    const url = await startStreamableServer();
    const transport = new StreamableHttpTransport(
      { transport: "http", url, headers: {} },
      { maxResponseBytes: 200 },
    );
    await expect(
      transport.request(createRequest(0, "big", {})),
    ).rejects.toMatchObject({ kind: "too-large" });
  });

  it("aborts an in-flight request", async () => {
    const url = await startStreamableServer();
    const transport = new StreamableHttpTransport({ transport: "http", url, headers: {} });
    const controller = new AbortController();
    const pending = transport.request(createRequest(0, "slow", {}), {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });
});

function startLegacyServer(): Promise<string> {
  let stream: ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      stream = res;
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    const body = await readBody(req);
    const message = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    res.statusCode = 202;
    res.end();
    if (!stream) return;
    const id = message.id;
    if (message.method === "initialize") {
      sseData(stream, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          serverInfo: { name: "legacy-mock", version: "1.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      sseData(stream, {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [{ name: "leg", description: "legacy tool", inputSchema: { type: "object", properties: {} } }],
        },
      });
    } else if (message.method === "tools/call") {
      sseData(stream, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "legacy-pong" }] },
      });
    }
  });
  return listen(server);
}

describe("legacy SSE transport", () => {
  it("discovers the endpoint, handshakes, and routes tool calls over the stream", async () => {
    const url = await startLegacyServer();
    const transport = new LegacySseTransport({ transport: "sse", url, headers: {} });
    const client = new McpClient(transport);

    const init = await client.initialize();
    expect(init.serverInfo?.name).toBe("legacy-mock");
    expect(init.protocolVersion).toBe("2024-11-05");

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["leg"]);

    const result = await client.callTool("leg", {});
    expect(result.text).toBe("legacy-pong");

    await client.close();
  });
});
