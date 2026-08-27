import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { McpManager, type McpTransportFactory } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpTransport } from "../../src/mcp/transport.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../src/mcp/types.js";
import { createCompositionRoot } from "../../src/ui-core/bootstrap/composition-root.js";
import { detectCapabilities } from "../../src/ui-core/bootstrap/capabilities.js";
import { attachCommandHandlers } from "../../src/ui-core/commands/command-handlers.js";
import { composerActionPort } from "../../src/ui-core/composer/composer-action-port.js";

class CommandTransport implements McpTransport {
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
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "docs", version: "1" },
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
              name: "search",
              description: "Search documentation",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
              },
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

const factory: McpTransportFactory = () => new CommandTransport();

function persistence(): PersistencePort {
  return {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

let root: string;
let workspace: string;
let home: string;
let previousCwd: string;
let runtime: McpRuntime;

beforeEach(async () => {
  previousCwd = process.cwd();
  root = mkdtempSync(join(tmpdir(), "clai-mcp-command-"));
  workspace = join(root, "project");
  home = join(root, "home");
  mkdirSync(join(workspace, ".clai"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, ".clai", "mcp.json"),
    JSON.stringify({ servers: { docs: { command: "docs-server" } } }),
  );
  process.chdir(workspace);
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
});

afterEach(async () => {
  await runtime.closeAll();
  process.chdir(previousCwd);
  rmSync(root, { recursive: true, force: true });
});

function services() {
  const app = createCompositionRoot({
    mcp: runtime,
    persistence: persistence(),
    capabilities: detectCapabilities({
      env: {},
      stdoutIsTTY: true,
      stdinIsTTY: true,
      columns: 120,
      rows: 40,
    }),
  });
  attachCommandHandlers(app);
  return app;
}

describe("/mcp shared command", () => {
  it("opens a status-rich picker and inserts the picked server as a composer token", async () => {
    const start = vi.spyOn(runtime, "start");
    const ensureReady = vi.spyOn(runtime, "ensureReady");
    const app = services();
    const inserted: string[] = [];
    const release = composerActionPort.registerInsert((text) => inserted.push(text));
    expect(app.commands.resolve("mcp")).toBe("mcp");
    expect(start).not.toHaveBeenCalled();
    expect(ensureReady).not.toHaveBeenCalled();
    expect(runtime.getState().selection).toEqual({ mode: "off" });
    expect(runtime.toolNames()).toEqual([]);

    const pending = app.commands.dispatch({ name: "mcp", args: "" });
    // The picker must be on screen before discovery resolves: a remote server
    // can take up to the connect timeout, and waiting looked like a freeze.
    expect(app.overlay.getState().kind).toBe("picker");
    await pending;
    expect(ensureReady).toHaveBeenCalledOnce();
    expect(start).not.toHaveBeenCalled();
    const overlay = app.overlay.getState();
    expect(overlay.kind).toBe("picker");
    if (overlay.kind === "picker") {
      expect(overlay.request.title).toContain("1/1 live");
      expect(overlay.request.title).toContain("0 active tools");
      expect(overlay.request.options.find((option) => option.value === "__mcp_add__")?.label)
        .toBe("+ add MCP server");
      expect(overlay.request.options.find((option) => option.value === "__mcp_off__"))
        .toMatchObject({ active: true });
      const docs = overlay.request.options.find((option) => option.value === "docs");
      expect(docs?.description).toContain("stdio");
      expect(docs?.description).toContain("clai-project");
      expect(docs?.description).toContain("1 tool");
      app.overlay.selectPicker("docs");
    }

    expect(inserted).toEqual(["@mcp:docs "]);
    expect(runtime.getState().selection).toEqual({ mode: "off" });
    expect(runtime.applyMentionSelection("read @mcp:docs now").selection).toEqual({
      mode: "servers",
      serverNames: ["docs"],
    });
    expect(runtime.toolNames()).toEqual(["mcp.docs.search"]);
    release();
    app.dispose();
  });

  it("keeps every mentioned server live and drops the ones deleted from the draft", async () => {
    const app = services();
    await runtime.refresh();
    expect(runtime.applyMentionSelection("@mcp:docs @mcp:docs go").selection).toEqual({
      mode: "servers",
      serverNames: ["docs"],
    });
    expect(runtime.applyMentionSelection("go").selection).toEqual({ mode: "off" });

    await app.commands.dispatch({ name: "mcp", args: "all" });
    expect(runtime.applyMentionSelection("@mcp:docs go").selection).toEqual({
      mode: "servers",
      serverNames: ["docs"],
    });
    expect(runtime.applyMentionSelection("go").selection).toEqual({ mode: "all" });
    app.dispose();
  });

  it("shows canonical tools and source paths in list/status pagers", async () => {
    const app = services();
    await app.commands.dispatch({ name: "mcp", args: "list" });
    let overlay = app.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind === "pager") {
      expect(overlay.body).toContain("Project config: .clai/mcp.json");
      expect(overlay.body).toContain("mcp.docs.search");
      expect(overlay.body).toContain(".clai/mcp.json");
      expect(overlay.body).toContain("ready");
      expect(overlay.body).toContain("Selection: off · active tools: 0");
    }

    app.overlay.close();
    await app.commands.dispatch({ name: "mcp", args: "status" });
    overlay = app.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind === "pager") {
      expect(overlay.body).toContain("Project config: .clai/mcp.json");
      expect(overlay.body).toContain("Selection: off · 0 active tools");
    }
    app.dispose();
  });

  it("switches between off and all-live session semantics", async () => {
    const app = services();
    expect(runtime.getState().selection).toEqual({ mode: "off" });
    expect(runtime.toolNames()).toEqual([]);

    await app.commands.dispatch({ name: "mcp", args: "all" });
    expect(runtime.getState().selection).toEqual({ mode: "all" });
    expect(runtime.toolNames()).toEqual(["mcp.docs.search"]);

    await app.commands.dispatch({ name: "mcp", args: "off" });
    expect(runtime.getState().selection).toEqual({ mode: "off" });
    expect(runtime.toolNames()).toEqual([]);
    app.dispose();
  });

  it("shows project and discovered inherited configuration locations", async () => {
    const inherited = join(home, ".config", "clai", "mcp.json");
    mkdirSync(join(home, ".config", "clai"), { recursive: true });
    writeFileSync(
      inherited,
      JSON.stringify({ servers: { global: { command: "global-server" } } }),
    );
    await runtime.refresh({ force: true });

    const app = services();
    await app.commands.dispatch({ name: "mcp", args: "locations" });
    const overlay = app.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind === "pager") {
      expect(overlay.title).toBe("MCP configuration locations");
      expect(overlay.body).toContain("Project config: .clai/mcp.json");
      expect(overlay.body).toContain(`Inherited config: ${inherited}`);
    }
    app.dispose();
  });

  it("adds one supplied server to project config and selects it", async () => {
    const app = services();
    await app.commands.dispatch({
      name: "mcp",
      args: 'add {"name":"alpha","command":"alpha-server","args":[]}',
    });

    expect(runtime.getState().selection).toEqual({
      mode: "servers",
      serverNames: ["alpha"],
    });
    expect(runtime.toolNames()).toEqual(["mcp.alpha.search"]);
    const config = JSON.parse(
      readFileSync(join(workspace, ".clai", "mcp.json"), "utf8"),
    ) as { servers: Record<string, unknown> };
    expect(Object.keys(config.servers)).toEqual(["alpha", "docs"]);
    expect(config.servers.alpha).toEqual({ args: [], command: "alpha-server" });
    expect(
      app.toast.getToasts().some((toast) =>
        toast.message.includes(
          "added MCP server alpha in .clai/mcp.json · use @mcp:alpha in your prompt",
        ),
      ),
    ).toBe(true);
    app.dispose();
  });

  it("opens a multiline add-server editor with an empty buffer", async () => {
    const app = services();
    await app.commands.dispatch({ name: "mcp", args: "" });
    app.overlay.selectPicker("__mcp_add__");

    let overlay = app.overlay.getState();
    expect(overlay.kind).toBe("text-editor");
    if (overlay.kind === "text-editor") {
      expect(overlay.request).toMatchObject({
        title: "Add MCP server",
        submitLabel: "add server",
      });
      expect(overlay.request.initialValue).toBeUndefined();
      expect(overlay.request.placeholder).toContain("command");
      expect(overlay.request.prompt).toContain(".clai/mcp.json");
    }

    app.overlay.answerTextEditor(
      '{\n  "servers": {\n    "local": {\n      "command": "local-server"\n    }\n  }\n}',
    );
    await vi.waitFor(() => {
      expect(runtime.getState().selection).toEqual({
        mode: "servers",
        serverNames: ["local"],
      });
    });
    overlay = app.overlay.getState();
    expect(overlay.kind).toBe("none");
    expect(runtime.toolNames()).toEqual(["mcp.local.search"]);
    app.dispose();
  });

  it("reopens the editor with the text intact when the JSON is rejected", async () => {
    const app = services();
    await app.commands.dispatch({ name: "mcp", args: "" });
    app.overlay.selectPicker("__mcp_add__");
    expect(app.overlay.getState().kind).toBe("text-editor");

    const broken = '{\n  "servers": {\n    "oops": {}\n';
    app.overlay.answerTextEditor(broken);
    await vi.waitFor(() => {
      const overlay = app.overlay.getState();
      expect(overlay.kind).toBe("text-editor");
      if (overlay.kind === "text-editor") {
        expect(overlay.request.initialValue).toBe(broken);
        expect(overlay.request.title).toContain("retry");
      }
    });

    app.overlay.answerTextEditor(undefined);
    await vi.waitFor(() => {
      expect(app.overlay.getState().kind).toBe("none");
    });
    app.dispose();
  });
});