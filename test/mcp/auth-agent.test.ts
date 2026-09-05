import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpManager, type McpTransportFactory } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import { McpTransportError, type McpTransport } from "../../src/mcp/transport.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../src/mcp/types.js";
import type { McpAuthProvider } from "../../src/mcp/auth/types.js";
import { classifyToolCall } from "../../src/safety/classifier.js";
import {
  getToolDefinitions,
  mcpAgentToolNames,
  MCP_AGENT_TOOL_NAMES,
  NON_REGISTRY_TOOL_NAMES,
} from "../../src/tools/definitions.js";

class LookupTransport implements McpTransport {
  readonly kind = "stdio" as const;
  constructor(private readonly name: string) {}
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
          serverInfo: { name: this.name, version: "1.0.0" },
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
              name: "lookup",
              description: "Look up a record",
              inputSchema: { type: "object", properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        },
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

let root: string;
let workspace: string;
let home: string;

function discovery() {
  return {
    workspaceFolder: workspace,
    homeDir: home,
    env: { XDG_CONFIG_HOME: join(home, ".config") },
    platform: "linux" as const,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clai-mcp-agent-"));
  workspace = join(root, "proj");
  home = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("live OAuth token redaction", () => {
  it("masks a live provider secret in a connection error", async () => {
    writeFileSync(
      join(workspace, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: { url: "https://api.example.com/mcp", type: "http", auth: { kind: "oauth" } },
        },
      }),
    );
    const provider: McpAuthProvider = {
      kind: "oauth",
      async headers() {
        return {};
      },
      async onUnauthorized() {
        return false;
      },
      liveSecrets() {
        return ["LIVE-OAUTH-TOKEN"];
      },
    };
    const failing: McpTransportFactory = (definition) => ({
      kind: "http",
      start: () => Promise.resolve(),
      request: (message: JsonRpcRequest) =>
        message.method === "initialize"
          ? Promise.resolve({
              jsonrpc: "2.0",
              id: message.id,
              result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: definition.name, version: "1" } },
            })
          : Promise.reject(new McpTransportError("protocol", "list failed for LIVE-OAUTH-TOKEN")),
      notify: () => Promise.resolve(),
      close: () => Promise.resolve(),
      sessionId: () => undefined,
      setProtocolVersion: () => undefined,
    });
    const manager = new McpManager({
      discovery: discovery(),
      transportFactory: failing,
      authProviderFactory: () => provider,
    });
    const snapshot = await manager.refresh();
    const status = snapshot.statuses.find((entry) => entry.name === "remote");
    expect(status?.detail).toBeDefined();
    expect(status?.detail).not.toContain("LIVE-OAUTH-TOKEN");
    expect(status?.detail).toContain("***");
    expect(manager.liveSecrets("remote")).toContain("LIVE-OAUTH-TOKEN");
    await manager.closeAll();
  });
});

describe("MCP agent tool safety classification", () => {
  it("classifies read-only listing tools as safe", () => {
    expect(classifyToolCall({ name: "mcp.list", args: {} }).level).toBe("safe");
    expect(classifyToolCall({ name: "mcp.tools", args: {} }).level).toBe("safe");
  });

  it("classifies mutating session tools as confirm", () => {
    expect(classifyToolCall({ name: "mcp.enable", args: {} }).level).toBe("confirm");
    expect(classifyToolCall({ name: "mcp.connect", args: { server: "x" } }).level).toBe("confirm");
    expect(classifyToolCall({ name: "mcp.login", args: { server: "x" } }).level).toBe("confirm");
  });
});

describe("MCP agent tool ask-mode filtering", () => {
  it("exposes only read-only tools in ask mode", () => {
    expect(mcpAgentToolNames(true)).toEqual(["mcp.list", "mcp.tools"]);
    expect(mcpAgentToolNames(false)).toEqual([
      "mcp.list",
      "mcp.tools",
      "mcp.enable",
      "mcp.connect",
      "mcp.login",
      "mcp.add",
    ]);
    const askNames = new Set(getToolDefinitions({ askMode: true }).map((d) => d.name));
    expect(askNames.has("mcp.list")).toBe(true);
    expect(askNames.has("mcp.tools")).toBe(true);
    expect(askNames.has("mcp.enable")).toBe(false);
    expect(askNames.has("mcp.login")).toBe(false);
    expect(askNames.has("mcp.add")).toBe(false);
  });

  it("registers all agent tools as non-registry meta tools", () => {
    for (const name of MCP_AGENT_TOOL_NAMES) {
      expect(NON_REGISTRY_TOOL_NAMES.has(name)).toBe(true);
    }
  });
});

describe("McpRuntime agent tool dispatch", () => {
  const factory: McpTransportFactory = (definition) => new LookupTransport(definition.name);

  function makeRuntime(): McpRuntime {
    return new McpRuntime({
      managerOptions: { discovery: discovery(), transportFactory: factory },
    });
  }

  beforeEach(() => {
    writeFileSync(
      join(workspace, ".mcp.json"),
      JSON.stringify({ mcpServers: { alpha: { command: "a" } } }),
    );
  });

  it("lists servers and tools", async () => {
    const runtime = makeRuntime();
    await runtime.start();
    const list = await runtime.agentList();
    expect(list.ok).toBe(true);
    expect(list.output).toContain("alpha");
    const tools = await runtime.agentTools();
    expect(tools.output).toContain("mcp.alpha.lookup");
    await runtime.closeAll();
  });

  it("enables a server for the session", async () => {
    const runtime = makeRuntime();
    await runtime.start();
    const enabled = await runtime.agentEnable("alpha");
    expect(enabled.ok).toBe(true);
    expect(runtime.getState().selection.mode).toBe("servers");
    expect(runtime.getState().activeToolCount).toBeGreaterThan(0);
    await runtime.closeAll();
  });

  it("connects a server and reports readiness", async () => {
    const runtime = makeRuntime();
    await runtime.start();
    const connect = await runtime.agentConnect("alpha");
    expect(connect.ok).toBe(true);
    expect(connect.output).toContain("ready");
    await runtime.closeAll();
  });

  it("reports that a stdio server does not use OAuth login", async () => {
    const runtime = makeRuntime();
    await runtime.start();
    const login = await runtime.agentLogin("alpha");
    expect(login.ok).toBe(false);
    expect(login.output).toMatch(/stdio|OAuth/i);
    await runtime.closeAll();
  });
});

describe("successful OAuth reconnect", () => {
  it("replaces the unauthorized state with a ready tool catalog", async () => {
    writeFileSync(
      join(workspace, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          remote: {
            url: "https://api.example.com/mcp",
            type: "http",
            auth: { kind: "oauth" },
          },
        },
      }),
    );
    let authenticated = false;
    const provider: McpAuthProvider = {
      kind: "oauth",
      async headers() {
        return authenticated ? { authorization: "Bearer TOKEN" } : {};
      },
      async onUnauthorized() {
        authenticated = true;
        return true;
      },
      liveSecrets() {
        return authenticated ? ["TOKEN"] : [];
      },
    };
    const transportFactory: McpTransportFactory = (definition) => {
      const transport = new LookupTransport(definition.name);
      return {
        kind: "http",
        start: () => Promise.resolve(),
        request: (message) =>
          authenticated
            ? transport.request(message)
            : Promise.reject(new McpTransportError("network", "401 Unauthorized")),
        notify: (message) => transport.notify(message),
        close: () => transport.close(),
        sessionId: () => undefined,
        setProtocolVersion: () => undefined,
      };
    };
    const manager = new McpManager({
      discovery: discovery(),
      transportFactory,
      authProviderFactory: () => provider,
    });
    const runtime = new McpRuntime({ manager });

    await runtime.refresh();
    expect(runtime.getState().snapshot.statuses[0]?.status).toBe("error");
    const result = await runtime.agentLogin("remote");
    expect(result.ok).toBe(true);
    expect(runtime.getState().snapshot.statuses[0]).toMatchObject({
      name: "remote",
      status: "ready",
      toolCount: 1,
    });
    expect(runtime.getState().snapshot.tools[0]?.canonicalName).toBe(
      "mcp.remote.lookup",
    );
    await runtime.closeAll();
  });
});
