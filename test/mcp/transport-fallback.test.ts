import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { McpManager } from "../../src/mcp/manager.js";

const servers: Server[] = [];
let workspace: string;
let home: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "clai-mcp-fallback-"));
  home = mkdtempSync(join(tmpdir(), "clai-mcp-fallback-home-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

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

function writeConfig(name: string, entry: Record<string, unknown>): void {
  mkdirSync(join(workspace, ".clai"), { recursive: true });
  writeFileSync(
    join(workspace, ".clai", "mcp.json"),
    JSON.stringify({ servers: { [name]: entry } }),
  );
}

function makeManager(): McpManager {
  return new McpManager({
    discovery: {
      workspaceFolder: workspace,
      homeDir: home,
      env: {},
      platform: "linux",
    },
  });
}

function startSseOnlyServer(): Promise<string> {
  let stream: ServerResponse | undefined;
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      stream = res;
      res.write("event: endpoint\ndata: /messages\n\n");
      return;
    }
    if (req.url !== "/messages") {
      res.statusCode = 404;
      res.end("not found");
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
          serverInfo: { name: "sse-only", version: "1.0.0" },
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

function startHttpOnlyServer(): Promise<string> {
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const body = await readBody(req);
    const message = body ? (JSON.parse(body) as Record<string, unknown>) : {};
    const id = message.id;
    if (message.method === "initialize") {
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "sess-1");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "http-only", version: "1.0.0" },
          },
        }),
      );
      return;
    }
    if (message.method === "notifications/initialized") {
      res.statusCode = 202;
      res.end();
      return;
    }
    if (message.method === "tools/list") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "ping",
                description: "ping",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        }),
      );
      return;
    }
    if (message.method === "tools/call") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: "pong" }] },
        }),
      );
      return;
    }
    res.statusCode = 400;
    res.end(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code: -32601, message: "nope" } }));
  });
  return listen(server);
}

describe("manager transport fallback", () => {
  it("falls back from streamable-http to legacy SSE on 404", async () => {
    const url = await startSseOnlyServer();
    writeConfig("legacy", { url, type: "http", auth: { kind: "none" } });
    const manager = makeManager();
    try {
      const snapshot = await manager.refresh();
      const status = snapshot.statuses.find((entry) => entry.name === "legacy");
      expect(status?.status).toBe("ready");
      expect(status?.toolCount).toBe(1);
      expect(status?.detail).toMatch(/fallback/i);
      const result = await manager.callTool("mcp.legacy.leg", {});
      expect(result.ok).toBe(true);
    } finally {
      await manager.closeAll();
    }
  });

  it("falls back from legacy SSE to streamable-http when the stream is rejected", async () => {
    const url = await startHttpOnlyServer();
    writeConfig("modern", { url, type: "sse", auth: { kind: "none" } });
    const manager = makeManager();
    try {
      const snapshot = await manager.refresh();
      const status = snapshot.statuses.find((entry) => entry.name === "modern");
      expect(status?.status).toBe("ready");
      expect(status?.toolCount).toBe(1);
      expect(status?.detail).toMatch(/fallback/i);
      const result = await manager.callTool("mcp.modern.ping", {});
      expect(result.ok).toBe(true);
    } finally {
      await manager.closeAll();
    }
  });
});
