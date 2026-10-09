import { createHash } from "node:crypto";
import type { ToolResult } from "../types.js";
import type { McpToolMetadata } from "./types.js";

export const MCP_CONTEXT_CATALOG_CHARS = 8_000;
export const MCP_TOOL_PAGE_CHARS = 24_000;

export interface McpToolQuery {
  readonly query?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export function toolCatalogPage(
  catalog: readonly McpToolMetadata[],
  options: McpToolQuery,
  render: (tool: McpToolMetadata) => string,
): ToolResult {
  const query = options.query?.trim().toLowerCase() ?? "";
  const words = query.split(/\s+/).filter(Boolean);
  const tools = catalog.filter((tool) => {
    const text = `${tool.canonicalName} ${tool.title ?? ""} ${tool.description}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const signature = createHash("sha256")
    .update(JSON.stringify([query, tools]))
    .digest("hex")
    .slice(0, 16);
  let offset = 0;
  if (options.cursor) {
    const match = /^([a-f0-9]{16}):(\d+)$/.exec(options.cursor);
    offset = Number(match?.[2]);
    if (
      match?.[1] !== signature ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= tools.length
    ) {
      return {
        ok: false,
        output:
          "MCP tool cursor is invalid or the catalog changed. Repeat mcp.tools with the same server and query without a cursor.",
        exitCode: 1,
      };
    }
  }
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(50, Math.floor(options.limit!)))
    : 12;
  const lines: string[] = [];
  let chars = 0;
  for (const tool of tools.slice(offset, offset + limit)) {
    const line = render(tool);
    if (lines.length > 0 && chars + line.length > MCP_TOOL_PAGE_CHARS) break;
    lines.push(line);
    chars += line.length + 1;
  }
  const next = offset + lines.length;
  const heading =
    tools.length > 0
      ? `MCP tools ${offset + 1}–${next} of ${tools.length}${query ? ` matching ${JSON.stringify(query)}` : ""}.`
      : "No MCP tools match this query. Use mcp.list to inspect server connection status.";
  if (next < tools.length)
    lines.push(
      `Next cursor: ${signature}:${next}. Pass it to mcp.tools with the same server and query.`,
    );
  lines.push(
    "Call through mcp.call with the exact dotted name and matching arguments. Enable the server with mcp.enable if it is not selected.",
  );
  return { ok: true, output: [heading, ...lines].join("\n"), exitCode: 0 };
}
