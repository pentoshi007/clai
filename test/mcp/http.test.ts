import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { LegacySseTransport, StreamableHttpTransport } from "../../src/mcp/transport-http.js";
import { McpClient } from "../../src/mcp/client.js";
import { createNotification, createRequest } from "../../src/mcp/jsonrpc.js";
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
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { blob: "x".repeat(5000) },
        }),
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
          result: {
            content: [{ type: "text", text: `pong ${protocol ?? ""}` }],
          },
        }),
      );
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "nope" },
      }),
    );
  });
  return listen(server);
}

describe("streamable HTTP transport", () => {
  it("rejects mismatched JSON response ids", async () => {
    const url = await listen(
      createServer(async (req, res) => {
        await readBody(req);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 9999, result: {} }));
      }),
    );
    const transport = new StreamableHttpTransport({
      transport: "http",
      url,
      headers: {},
    });
    await expect(transport.request(createRequest(0, "ping"))).rejects.toMatchObject({
      kind: "protocol",
    });
    await transport.close();
  });

  it("reports HTTP notification errors and preserves timeout classification", async () => {
    const url = await listen(
      createServer(async (req, res) => {
        const message = JSON.parse(await readBody(req));
        if (message.method === "slow") return;
        res.statusCode = 503;
        res.end("not ready");
      }),
    );
    const transport = new StreamableHttpTransport({
      transport: "http",
      url,
      headers: {},
    });
    await expect(
      transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      transport.request(createRequest(0, "slow"), { timeoutMs: 30 }),
    ).rejects.toMatchObject({ kind: "timeout" });
    await transport.close();
  });

  it("resumes an interrupted SSE response by event id without repeating its POST", async () => {
    let id: unknown;
    let posts = 0;
    const resumeIds: unknown[] = [];
    const url = await listen(
      createServer(async (req, res) => {
        res.setHeader("content-type", "text/event-stream");
        if (req.method === "POST") {
          const message = JSON.parse(await readBody(req));
          id = message.id;
          posts++;
          res.end("id: checkpoint-1\ndata: \n\n");
        } else {
          resumeIds.push(req.headers["last-event-id"]);
          sseData(res, { jsonrpc: "2.0", id, result: { complete: true } });
          res.end();
        }
      }),
    );
    const transport = new StreamableHttpTransport({
      transport: "http",
      url,
      headers: {},
    });
    expect(
      await transport.request(createRequest(0, "tools/call", { name: "write" })),
    ).toMatchObject({ result: { complete: true } });
    expect(posts).toBe(1);
    expect(resumeIds).toEqual(["checkpoint-1"]);
    await transport.close();
  });

  it("answers server requests embedded in an SSE tool response", async () => {
    let stream: ServerResponse | undefined;
    let requestId: unknown;
    const url = await listen(
      createServer(async (req, res) => {
        const message = JSON.parse(await readBody(req));
        if (message.method === "initialize") {
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
              },
            }),
          );
        } else if (message.method === "notifications/initialized") {
          res.statusCode = 202;
          res.end();
        } else if (message.method === "tools/call") {
          stream = res;
          requestId = message.id;
          res.setHeader("content-type", "text/event-stream");
          sseData(res, { jsonrpc: "2.0", id: "server-ping", method: "ping" });
        } else {
          expect(message).toEqual({
            jsonrpc: "2.0",
            id: "server-ping",
            result: {},
          });
          res.statusCode = 202;
          res.end();
          sseData(stream!, {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [{ type: "text", text: "completed after ping" }],
            },
          });
          stream!.end();
        }
      }),
    );
    const client = new McpClient(
      new StreamableHttpTransport({ transport: "http", url, headers: {} }),
    );
    await client.initialize();
    expect((await client.callTool("lookup", {})).text).toBe("completed after ping");
    await client.close();
  });
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
    const client = new McpClient(
      new StreamableHttpTransport({ transport: "http", url, headers: {} }),
    );
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
    await expect(transport.request(createRequest(0, "big", {}))).rejects.toMatchObject({
      kind: "too-large",
    });
  });

  it("aborts an in-flight request", async () => {
    const url = await startStreamableServer();
    const transport = new StreamableHttpTransport({
      transport: "http",
      url,
      headers: {},
    });
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
          tools: [
            {
              name: "leg",
              description: "legacy tool",
              inputSchema: { type: "object", properties: {} },
            },
          ],
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
  it("bounds notification time while credentials are unavailable", async () => {
    const url = await startLegacyServer();
    let reads = 0;
    const transport = new LegacySseTransport(
      { transport: "sse", url, headers: {} },
      {
        authProvider: {
          kind: "oauth",
          headers: async () => {
            if (reads++ === 0) return {};
            return new Promise<Record<string, string>>(() => undefined);
          },
          onUnauthorized: async () => false,
          liveSecrets: () => [],
        },
      },
    );
    try {
      await transport.start();
      await expect(
        transport.notify(createNotification("notifications/initialized"), { timeoutMs: 30 }),
      ).rejects.toMatchObject({ kind: "timeout" });
    } finally {
      await transport.close();
    }
  });

  it("rejects a cross-origin endpoint before forwarding authorization", async () => {
    let leaked = false;
    const destination = await listen(
      createServer((_req, res) => {
        leaked = true;
        res.end();
      }),
    );
    const url = await listen(
      createServer((_req, res) => {
        res.setHeader("content-type", "text/event-stream");
        res.end(`event: endpoint\ndata: ${destination}/messages\n\n`);
      }),
    );
    const transport = new LegacySseTransport({
      transport: "sse",
      url,
      headers: { authorization: "Bearer PRIVATE" },
    });
    await expect(transport.start({ timeoutMs: 500 })).rejects.toMatchObject({
      kind: "protocol",
    });
    expect(leaked).toBe(false);
    await transport.close();
  });

  it("bounds connection time when the server never announces an endpoint", async () => {
    const url = await listen(
      createServer((_req, res) => {
        res.setHeader("content-type", "text/event-stream");
        res.write(": waiting\n\n");
      }),
    );
    const transport = new LegacySseTransport({
      transport: "sse",
      url,
      headers: {},
    });
    await expect(transport.start({ timeoutMs: 30 })).rejects.toMatchObject({
      kind: "timeout",
    });
    await transport.close();
  });

  it("fails promptly when the legacy stream ends before announcing an endpoint", async () => {
    const url = await listen(
      createServer((_req, res) => {
        res.setHeader("content-type", "text/event-stream");
        res.end(": done\n\n");
      }),
    );
    const transport = new LegacySseTransport({
      transport: "sse",
      url,
      headers: {},
    });
    await expect(transport.start({ timeoutMs: 500 })).rejects.toMatchObject({
      kind: "closed",
    });
    await transport.close();
  });
  it("discovers the endpoint, handshakes, and routes tool calls over the stream", async () => {
    const url = await startLegacyServer();
    const transport = new LegacySseTransport({
      transport: "sse",
      url,
      headers: {},
    });
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
