import { describe, expect, it } from "vitest";
import { toolCatalogPage } from "../../src/mcp/catalog.js";
import type { McpToolMetadata } from "../../src/mcp/types.js";

function meta(server: string, name: string, description: string, title?: string): McpToolMetadata {
  return {
    canonicalName: `mcp.${server}.${name}`,
    wireName: `mcp_${server}_${name}`,
    serverName: server,
    toolName: name,
    ...(title ? { title } : {}),
    description,
    inputSchema: { type: "object", properties: {} },
    risk: "low",
    readOnly: true,
    destructive: false,
    idempotent: true,
    openWorld: false,
    annotations: {},
  } as McpToolMetadata;
}

const CATALOG = [
  meta("rea", "open_binary", "Open a binary for analysis."),
  meta("rea", "list_functions", "List functions. Requires open_binary first."),
  meta("rea", "find_strings", "Find strings. Requires open_binary first."),
  meta("docs", "open_binary", "Documentation viewer for binary manuals.", "Open Binary"),
];

const names = (output: string): string[] =>
  output.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2).split(" ")[0]!);

describe("mcp.tools exact-name lookup", () => {
  const page = (query: string, cursor?: string) =>
    toolCatalogPage(CATALOG, { query, ...(cursor ? { cursor } : {}) }, (tool) => `- ${tool.canonicalName}`);

  it("returns only the named tool instead of every tool that mentions it", () => {
    expect(names(page("list_functions").output)).toEqual(["mcp.rea.list_functions"]);
  });

  it("returns every server that exposes the same exact name", () => {
    expect(names(page("open_binary").output)).toEqual(["mcp.rea.open_binary", "mcp.docs.open_binary"]);
  });

  it("accepts the canonical name, the wire name and the title", () => {
    expect(names(page("mcp.rea.find_strings").output)).toEqual(["mcp.rea.find_strings"]);
    expect(names(page("mcp_rea_find_strings").output)).toEqual(["mcp.rea.find_strings"]);
    expect(names(page("Open Binary").output)).toEqual(["mcp.docs.open_binary"]);
  });

  it("keeps keyword search for queries that are not a tool name", () => {
    expect(names(page("requires open_binary").output)).toEqual(["mcp.rea.list_functions", "mcp.rea.find_strings"]);
    expect(names(page("strings").output)).toEqual(["mcp.rea.find_strings"]);
    expect(page("nothing here").output).toContain("No MCP tools match");
  });
});
