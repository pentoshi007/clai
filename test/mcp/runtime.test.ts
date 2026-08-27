import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromWireName } from "../../src/llm/tool-protocol.js";
import { McpManager, type McpTransportFactory } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import type { McpTransport } from "../../src/mcp/transport.js";
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from "../../src/mcp/types.js";
import { getToolDefinitions } from "../../src/tools/definitions.js";

const closeCounts = new Map<string, number>();

class RuntimeTransport implements McpTransport {
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
      const tools =
        this.name === "alpha"
          ? [
              {
                name: "lookup",
                description: "Look up an indexed record",
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                  additionalProperties: false,
                },
                annotations: { readOnlyHint: true, idempotentHint: true },
              },
            ]
          : [
              {
                name: "change",
                description: "Change a remote record",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
                annotations: { destructiveHint: true },
              },
            ];
      return Promise.resolve({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools },
      });
    }
    if (message.method === "tools/call") {
      const params = message.params as { name?: string };
      const result =
        params.name === "lookup"
          ? { content: [{ type: "text", text: "record secret-value" }] }
          : {
              content: [
                { type: "text", text: "changed" },
                { type: "image", data: "QUJD", mimeType: "image/png" },
              ],
            };
      return Promise.resolve({ jsonrpc: "2.0", id: message.id, result });
    }
    return Promise.resolve({ jsonrpc: "2.0", id: message.id, result: {} });
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
  new RuntimeTransport(definition.name);

let root: string;
let workspace: string;
let home: string;

function makeRuntime(): McpRuntime {
  const manager = new McpManager({
    discovery: {
      workspaceFolder: workspace,
      homeDir: home,
      env: { XDG_CONFIG_HOME: join(home, ".config") },
      platform: "linux",
    },
    transportFactory: factory,
  });
  return new McpRuntime({ manager });
}

beforeEach(() => {
  closeCounts.clear();
  root = mkdtempSync(join(tmpdir(), "clai-mcp-runtime-"));
  workspace = join(root, "project");
  home = join(root, "home");
  mkdirSync(join(workspace, ".clai"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(workspace, ".clai", "mcp.json"),
    JSON.stringify({
      servers: {
        beta: { command: "beta" },
        alpha: {
          command: "alpha",
          env: { TOKEN: "secret-value" },
        },
      },
    }),
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("McpRuntime catalog", () => {
  it("builds deterministic definitions after the unchanged core prefix", async () => {
    const runtime = makeRuntime();
    await runtime.refresh();
    const core = getToolDefinitions();
    expect(runtime.getState().selection).toEqual({ mode: "off" });
    expect(runtime.toolDefinitions()).toEqual([]);
    runtime.selectAll();
    const first = runtime.toolDefinitions();
    const combined = [...core, ...first];

    expect(first.map((definition) => definition.name)).toEqual([
      "mcp.alpha.lookup",
      "mcp.beta.change",
    ]);
    expect(combined.slice(0, core.length).map((definition) => definition.name)).toEqual(
      core.map((definition) => definition.name),
    );
    expect(first[0]?.wireName).toBe("mcp_alpha_lookup");
    expect(fromWireName("mcp_alpha_lookup")).toBe("mcp.alpha.lookup");
    expect(first[0]?.readOnly).toBe(true);
    expect(first[1]?.mutates).toBe(true);

    const signature = runtime.getState().catalogSignature;
    await runtime.refresh();
    expect(runtime.getState().catalogSignature).toBe(signature);
    expect(runtime.toolDefinitions()).toEqual(first);
    await runtime.closeAll();
  });

  it("filters ask-mode tools and applies session-only server selection", async () => {
    const runtime = makeRuntime();
    await runtime.refresh();

    expect(runtime.getState().selection).toEqual({ mode: "off" });
    expect(runtime.toolNames({ askMode: true })).toEqual([]);
    runtime.selectAll();
    expect(runtime.toolNames({ askMode: true })).toEqual(["mcp.alpha.lookup"]);
    runtime.selectServer("beta");
    expect(runtime.getState().selection).toEqual({
      mode: "servers",
      serverNames: ["beta"],
    });
    expect(runtime.toolNames()).toEqual(["mcp.beta.change"]);
    runtime.selectServers(["alpha", "beta"]);
    expect(runtime.toolNames()).toEqual(["mcp.alpha.lookup", "mcp.beta.change"]);
    runtime.selectOff();
    expect(runtime.getState().selection).toEqual({ mode: "off" });
    expect(runtime.toolNames()).toEqual([]);
    runtime.selectAll();
    expect(runtime.getState().selection).toEqual({ mode: "all" });
    expect(runtime.toolNames()).toHaveLength(2);
    await runtime.closeAll();
  });

  it("routes @mcp mentions to a multi-server selection and back to the base mode", async () => {
    const runtime = makeRuntime();
    await runtime.refresh();

    expect(runtime.serverNames()).toEqual(new Set(["alpha", "beta"]));
    expect(runtime.applyMentionSelection("use @mcp:alpha please").selection).toEqual({
      mode: "servers",
      serverNames: ["alpha"],
    });
    expect(
      runtime.applyMentionSelection("@mcp:alpha and @mcp:beta and @mcp:ghost").selection,
    ).toEqual({ mode: "servers", serverNames: ["alpha", "beta"] });
    expect(runtime.toolNames()).toEqual(["mcp.alpha.lookup", "mcp.beta.change"]);

    expect(runtime.applyMentionSelection("plain prompt").selection).toEqual({
      mode: "off",
    });
    expect(runtime.toolNames()).toEqual([]);

    runtime.selectAll();
    expect(runtime.applyMentionSelection("@mcp:beta only").selection).toEqual({
      mode: "servers",
      serverNames: ["beta"],
    });
    expect(runtime.applyMentionSelection("plain prompt").selection).toEqual({
      mode: "all",
    });

    const state = runtime.getState();
    expect(runtime.applyMentionSelection("still plain")).toBe(state);
    await runtime.closeAll();
  });
});

describe("McpRuntime calls and guidance", () => {
  it("routes canonical and wire calls, maps images, and redacts configured secrets", async () => {
    const runtime = makeRuntime();
    await runtime.refresh();
    runtime.selectAll();

    expect(runtime.classify("mcp.alpha.lookup")?.level).toBe("safe");
    expect(runtime.classify("mcp_beta_change")?.level).toBe("confirm");
    expect(runtime.isParallelSafe("mcp.alpha.lookup")).toBe(true);

    const read = await runtime.callTool("mcp_alpha_lookup", { id: "1" });
    expect(read.ok).toBe(true);
    expect(read.output).toBe("record ***");

    const write = await runtime.callTool("mcp.beta.change", { value: "x" });
    expect(write.ok).toBe(true);
    expect(write.images?.[0]?.mediaType).toBe("image/png");
    await runtime.closeAll();
  });

  it("renders native and fenced-tool context from only live selected tools", async () => {
    const runtime = makeRuntime();
    await runtime.refresh();

    expect(runtime.promptContext({ nativeTools: true })).toBeUndefined();
    runtime.selectAll();
    const native = runtime.promptContext({ nativeTools: true });
    expect(native).toContain("Live servers: 2/2");
    expect(native).toContain("mcp.alpha.lookup");
    expect(native).toContain("stronger direct result than a generic substitute");
    expect(native).toContain("untrusted data");
    expect(native).toContain("normal confirmation policy");
    expect(native).toContain("never invent unavailable MCP names");
    expect(native).not.toContain("args={");

    runtime.selectServer("alpha");
    const text = runtime.promptContext({ nativeTools: false });
    expect(text).toContain("args={");
    expect(text).toContain("mcp.alpha.lookup");
    expect(text).not.toContain("mcp.beta.change");
    await runtime.closeAll();
  });

  it("closes every connected server", async () => {
    const runtime = makeRuntime();
    await runtime.refresh();
    await runtime.closeAll();
    expect(closeCounts.get("alpha")).toBeGreaterThanOrEqual(1);
    expect(closeCounts.get("beta")).toBeGreaterThanOrEqual(1);
  });
});
