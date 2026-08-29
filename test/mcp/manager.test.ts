import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCatalog, formatStatuses } from "../../src/mcp/format.js";
import { McpManager, type McpTransportFactory } from "../../src/mcp/manager.js";
import { McpTransportError, type McpTransport } from "../../src/mcp/transport.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../src/mcp/types.js";

interface ServerSpec {
  readonly failList?: boolean;
  readonly tools?: ReadonlyArray<Record<string, unknown>>;
  readonly call?: (params: Record<string, unknown>) => unknown;
}

const specs: Record<string, ServerSpec> = {
  ready1: {
    tools: [
      {
        name: "do_read",
        description: "Read something",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
    call: () => ({ content: [{ type: "text", text: "read-ok" }] }),
  },
  ready2: {
    tools: [
      {
        name: "do_write",
        description: "Write something",
        inputSchema: { type: "object", properties: {} },
        annotations: { destructiveHint: true },
      },
    ],
    call: () => ({ content: [{ type: "image", data: "QUJD", mimeType: "image/png" }] }),
  },
  degraded: { failList: true },
};

const initCounts = new Map<string, number>();
const closeCounts = new Map<string, number>();

class FakeTransport implements McpTransport {
  readonly kind = "stdio" as const;

  constructor(
    private readonly name: string,
    private readonly spec: ServerSpec | undefined,
  ) {}

  start(): Promise<void> {
    return Promise.resolve();
  }

  request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = message.id;
    if (message.method === "initialize") {
      initCounts.set(this.name, (initCounts.get(this.name) ?? 0) + 1);
      return Promise.resolve({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: this.name, version: "1.0.0" },
        },
      });
    }
    if (message.method === "tools/list") {
      if (this.spec?.failList) {
        return Promise.reject(new McpTransportError("protocol", "list failed"));
      }
      return Promise.resolve({
        jsonrpc: "2.0",
        id,
        result: { tools: this.spec?.tools ?? [] },
      });
    }
    if (message.method === "tools/call") {
      const params = (message.params ?? {}) as Record<string, unknown>;
      return Promise.resolve({
        jsonrpc: "2.0",
        id,
        result: this.spec?.call?.(params) ?? { content: [] },
      });
    }
    return Promise.resolve({ jsonrpc: "2.0", id, result: {} });
  }

  notify(_message: JsonRpcNotification): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    closeCounts.set(this.name, (closeCounts.get(this.name) ?? 0) + 1);
    return Promise.resolve();
  }

  sessionId(): string | undefined {
    return undefined;
  }

  setProtocolVersion(): void {}
}

const factory: McpTransportFactory = (definition) =>
  new FakeTransport(definition.name, specs[definition.name]);

let root: string;
let workspace: string;
let home: string;

function makeManager(): McpManager {
  return new McpManager({
    discovery: {
      workspaceFolder: workspace,
      homeDir: home,
      env: { XDG_CONFIG_HOME: join(home, ".config") },
      platform: "linux",
    },
    transportFactory: factory,
  });
}

beforeEach(() => {
  initCounts.clear();
  closeCounts.clear();
  root = mkdtempSync(join(tmpdir(), "clai-mcp-manager-"));
  workspace = join(root, "proj");
  home = join(root, "home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        ready1: { command: "a" },
        ready2: { command: "b" },
        degraded: { command: "c" },
        off: { command: "d", disabled: true },
        broken: {},
      },
    }),
  );
  mkdirSync(join(workspace, ".vscode"), { recursive: true });
  writeFileSync(
    join(workspace, ".vscode", "mcp.json"),
    JSON.stringify({ servers: { ready1: { command: "shadowed" } } }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("shadowed alias resolution", () => {
  const loginCalls: string[] = [];

  function aliasManager(): McpManager {
    writeFileSync(
      join(workspace, ".clai", "mcp.json"),
      JSON.stringify({
        servers: { notion: { url: "https://mcp.notion.com/mcp" } },
      }),
    );
    writeFileSync(
      join(home, ".config", "Code", "User", "mcp.json"),
      JSON.stringify({
        servers: {
          "makenotion/notion-mcp-server": { url: "https://mcp.notion.com/sse" },
        },
      }),
    );
    return new McpManager({
      discovery: {
        workspaceFolder: workspace,
        homeDir: home,
        env: { XDG_CONFIG_HOME: join(home, ".config") },
        platform: "linux",
      },
      transportFactory: (definition) =>
        new FakeTransport(definition.name, { tools: [] }),
      authProviderFactory: (definition) => ({
        kind: "oauth" as const,
        headers: async () => ({}),
        onUnauthorized: async () => {
          loginCalls.push(definition.name);
          return true;
        },
        liveSecrets: () => [],
      }),
    });
  }

  beforeEach(() => {
    loginCalls.length = 0;
    rmSync(join(workspace, ".mcp.json"), { force: true });
    rmSync(join(workspace, ".vscode"), { recursive: true, force: true });
    mkdirSync(join(workspace, ".clai"), { recursive: true });
    mkdirSync(join(home, ".config", "Code", "User"), { recursive: true });
  });

  it("resolves a shadowed alias to the live server for reconnect", async () => {
    const manager = aliasManager();
    await manager.refresh();

    expect(manager.resolveServerName("makenotion/notion-mcp-server")).toBe("notion");
    const snapshot = await manager.reconnect("makenotion/notion-mcp-server");
    expect(snapshot.statuses.map((status) => status.name)).toEqual(["notion"]);
    expect(snapshot.statuses[0]?.status).toBe("ready");
    await manager.closeAll();
  });

  it("reports login and canLogin against the resolved server, not the alias", async () => {
    const manager = aliasManager();
    await manager.refresh();

    expect(manager.canLogin("makenotion/notion-mcp-server")).toBe(true);
    const result = await manager.login("makenotion/notion-mcp-server");
    expect(result.ok).toBe(true);
    expect(result.detail).toBe("Authenticated MCP server notion.");
    expect(loginCalls).toEqual(["notion"]);
    await manager.closeAll();
  });

  it("returns undefined for a name that is neither live nor a shadowed alias", async () => {
    const manager = aliasManager();
    await manager.refresh();

    expect(manager.resolveServerName("nope")).toBeUndefined();
    const result = await manager.login("nope");
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Unknown MCP server "nope"');
    await manager.closeAll();
  });
});

describe("manager snapshot and statuses", () => {
  it("produces ready, degraded, and disabled statuses with shadow and invalid tracking", async () => {
    const manager = makeManager();
    const snapshot = await manager.refresh();
    const byName = new Map(snapshot.statuses.map((status) => [status.name, status]));
    expect(byName.get("ready1")?.status).toBe("ready");
    expect(byName.get("ready2")?.status).toBe("ready");
    expect(byName.get("degraded")?.status).toBe("degraded");
    expect(byName.get("off")?.status).toBe("disabled");
    expect(snapshot.shadowed.some((server) => server.name === "ready1")).toBe(true);
    expect(snapshot.invalid.some((server) => server.name === "broken")).toBe(true);
    await manager.closeAll();
  });

  it("indexes canonical and wire tool names and derives risk from annotations", async () => {
    const manager = makeManager();
    const snapshot = await manager.refresh();
    const read = snapshot.toolsByCanonicalName.get("mcp.ready1.do_read");
    const write = snapshot.toolsByWireName.get("mcp_ready2_do_write");
    expect(read?.wireName).toBe("mcp_ready1_do_read");
    expect(read?.risk).toBe("safe");
    expect(read?.readOnly).toBe(true);
    expect(write?.canonicalName).toBe("mcp.ready2.do_write");
    expect(write?.risk).toBe("confirm");
    expect(write?.destructive).toBe(true);
    await manager.closeAll();
  });

  it("returns a frozen immutable snapshot", async () => {
    const manager = makeManager();
    const snapshot = await manager.refresh();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    await manager.closeAll();
  });

  it("treats URL-only servers as OAuth-capable unless auth is explicitly disabled", async () => {
    writeFileSync(
      join(workspace, ".mcp.json"),
      JSON.stringify({
        servers: {
          automatic: { url: "https://mcp.example.com/mcp" },
          disabled: {
            url: "https://none.example.com/mcp",
            auth: { kind: "none" },
          },
          local: { command: "local-server" },
        },
      }),
    );
    const manager = makeManager();
    await manager.refresh();
    expect(manager.canLogin("automatic")).toBe(true);
    expect(manager.canLogin("disabled")).toBe(false);
    expect(manager.canLogin("local")).toBe(false);
    await manager.closeAll();
  });
});

describe("manager tool routing and normalization", () => {
  it("routes canonical and wire tool calls to normalized results", async () => {
    const manager = makeManager();
    await manager.refresh();
    const text = await manager.callTool("mcp.ready1.do_read", {});
    expect(text.text).toBe("read-ok");
    const image = await manager.callTool("mcp_ready2_do_write", {});
    expect(image.chatImages[0]?.mediaType).toBe("image/png");
    await manager.closeAll();
  });

  it("throws for unknown tools", async () => {
    const manager = makeManager();
    await manager.refresh();
    await expect(manager.callTool("mcp.nope.x", {})).rejects.toBeInstanceOf(
      McpTransportError,
    );
    await manager.closeAll();
  });
});

describe("manager caching and lifecycle", () => {
  it("reuses connections with an unchanged signature and reconnects on force", async () => {
    const manager = makeManager();
    await manager.refresh();
    expect(initCounts.get("ready1")).toBe(1);
    await manager.refresh();
    expect(initCounts.get("ready1")).toBe(1);
    await manager.forceRefresh();
    expect(initCounts.get("ready1")).toBe(2);
    await manager.closeAll();
  });

  it("reconnects a single server", async () => {
    const manager = makeManager();
    await manager.refresh();
    const before = initCounts.get("ready1") ?? 0;
    await manager.reconnect("ready1");
    expect(initCounts.get("ready1")).toBe(before + 1);
    await manager.closeAll();
  });

  it("closes every connection on closeAll", async () => {
    const manager = makeManager();
    await manager.refresh();
    await manager.closeAll();
    expect(closeCounts.get("ready1")).toBeGreaterThanOrEqual(1);
    expect(closeCounts.get("ready2")).toBeGreaterThanOrEqual(1);
  });
});

describe("manager formatting", () => {
  it("formats canonical catalog and status output without throwing", async () => {
    const manager = makeManager();
    const snapshot = await manager.refresh();
    const catalog = formatCatalog(snapshot);
    expect(catalog).toContain("mcp.ready1.do_read");
    expect(catalog).toContain("ready1");
    const statuses = formatStatuses(snapshot.statuses);
    expect(statuses).toContain("degraded");
    await manager.closeAll();
  });
});
