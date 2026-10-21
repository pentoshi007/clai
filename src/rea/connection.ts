import type { McpRuntime } from "../mcp/runtime.js";
import type { McpServerStatus, McpToolMetadata } from "../mcp/types.js";
import { REA_SERVER } from "./workflow.js";

export interface ReaConnection {
  readonly server: McpServerStatus | undefined;
  readonly selected: boolean;
}

export function reaTools(runtime: Pick<McpRuntime, "getState">): McpToolMetadata[] {
  return runtime.getState().snapshot.tools.filter((tool) => tool.serverName === REA_SERVER);
}

export function reaConnection(runtime: Pick<McpRuntime, "getState">): ReaConnection {
  const { snapshot, selection } = runtime.getState();
  const server = snapshot.statuses.find((entry) => entry.name === REA_SERVER);
  const selected = server?.status === "ready" &&
    (selection.mode === "all" || (selection.mode === "servers" && selection.serverNames.includes(REA_SERVER)));
  return { server, selected };
}
