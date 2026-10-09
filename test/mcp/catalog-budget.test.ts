import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpManager } from "../../src/mcp/manager.js";
import { McpRuntime } from "../../src/mcp/runtime.js";
import { toToolMetadata } from "../../src/mcp/results.js";
import { MCP_CONTEXT_CATALOG_CHARS, toolCatalogPage } from "../../src/mcp/catalog.js";

const roots: string[] = [];
const runtimes: McpRuntime[] = [];

function tool(index: number) {
  return {
    name: `lookup_${String(index).padStart(4, "0")}`,
    description: `Look up ${index % 2 ? "tickets" : "documentation"} ${"details ".repeat(100)}`,
    inputSchema: {
      type: "object",
      properties: { query: { $ref: "#/$defs/Query" } },
      required: ["query"],
      $defs: { Query: { type: "string", minLength: 1 } },
    },
    annotations: { readOnlyHint: true },
  };
}

async function runtime(count: number): Promise<McpRuntime> {
  const root = mkdtempSync(join(tmpdir(), "clai-mcp-budget-"));
  roots.push(root);
  mkdirSync(join(root, ".clai"));
  writeFileSync(
    join(root, ".clai", "mcp.json"),
    JSON.stringify({ servers: { docs: { command: "fixture" } } }),
  );
  const manager = new McpManager({
    discovery: {
      workspaceFolder: root,
      homeDir: root,
      env: { CLAI_MCP_CONFIG: join(root, ".clai", "mcp.json") },
    },
    transportFactory: () => ({
      kind: "stdio",
      start: async () => undefined,
      request: async (request) => ({
        jsonrpc: "2.0",
        id: request.id,
        result:
          request.method === "initialize"
            ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
            : request.method === "tools/list"
              ? {
                  tools: Array.from({ length: count }, (_, index) => tool(index)),
                }
              : { content: [{ type: "text", text: "found" }] },
      }),
      notify: async () => undefined,
      close: async () => undefined,
      sessionId: () => undefined,
      setProtocolVersion: () => undefined,
    }),
  });
  const instance = new McpRuntime({ manager });
  runtimes.push(instance);
  await instance.start();
  instance.selectAll();
  return instance;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.closeAll()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP catalogs under a context budget", () => {
  it("defers large catalogs while keeping every selected tool callable", async () => {
    const instance = await runtime(1_000);
    const context = instance.promptContext({ nativeTools: true })!;
    expect(context.length).toBeLessThan(MCP_CONTEXT_CATALOG_CHARS);
    expect(context).toContain("schemas are deferred");
    expect(context).toContain("Active tools: 1000");
    expect(context).not.toContain("args=");
    expect((await instance.callTool("mcp.docs.lookup_0999", { query: "latest" })).output).toBe(
      "found",
    );
    const page = await instance.agentTools("docs", { query: "lookup_0999" });
    expect(page.output).toContain("mcp.docs.lookup_0999");
    expect(page.output).toContain('"$defs":{"Query"');
    expect(page.output).toContain('"$ref":"#/$defs/Query"');
    expect(page.output).not.toContain("lookup_0000");
  });

  it("keeps small catalogs inline and stable across an unchanged refresh", async () => {
    const instance = await runtime(2);
    const before = instance.promptContext({ nativeTools: true });
    const signature = instance.getState().catalogSignature;
    await instance.refresh();
    expect(instance.getState().catalogSignature).toBe(signature);
    expect(instance.promptContext({ nativeTools: true })).toBe(before);
    expect(before).toContain("args=");
  });

  it("pages matching schemas without skipping or repeating tools", async () => {
    const instance = await runtime(40);
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await instance.agentTools("docs", {
        query: "tickets",
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.ok).toBe(true);
      for (const match of page.output.matchAll(/^- (mcp\.docs\.lookup_\d+)/gm)) {
        expect(seen.has(match[1]!)).toBe(false);
        seen.add(match[1]!);
      }
      cursor = /Next cursor: ([a-f0-9]+:\d+)/.exec(page.output)?.[1];
    } while (cursor);
    expect(seen.size).toBe(20);
  });

  it("rejects stale cursors and cursors reused with another query", () => {
    const catalog = Array.from({ length: 4 }, (_, index) =>
      toToolMetadata("docs", tool(index), `mcp_docs_${index}`),
    );
    const page = toolCatalogPage(catalog, { limit: 1 }, (tool) => tool.canonicalName);
    const cursor = /Next cursor: ([a-f0-9]+:\d+)/.exec(page.output)![1]!;
    expect(
      toolCatalogPage(catalog, { cursor, query: "tickets" }, (tool) => tool.canonicalName).ok,
    ).toBe(false);
    expect(toolCatalogPage(catalog.slice(1), { cursor }, (tool) => tool.canonicalName).ok).toBe(
      false,
    );
    expect(toolCatalogPage(catalog, { cursor: "nonsense" }, (tool) => tool.canonicalName).ok).toBe(
      false,
    );
  });
});
