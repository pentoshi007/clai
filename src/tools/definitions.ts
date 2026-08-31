import type { ToolDefinition } from "../types.js";
import { toSnakeWireName, toWireName } from "../llm/tool-protocol.js";
import { byName } from "./definitions/selection.js";
import { TOOL_DEFINITIONS } from "./definitions/aggregate.js";
export { TOOL_DEFINITIONS };
export {
  assertDefinitionRegistryConsistency,
  getCompactToolDefinitions,
  getToolDefinitions,
} from "./definitions/selection.js";

/** Plan tools dispatched specially in the runner (not in toolRegistry). */
export const PLAN_TOOL_NAMES = new Set([
  "plan.clear",
  "plan.create",
  "task.add",
  "task.move",
  "task.read",
  "task.update",
]);

/** Plan-independent Responder receipt tools dispatched by the runner. */
export const RESPONDER_TOOL_NAMES = new Set(["job.read"]);

/** Every runner-owned meta tool that has no registry handler. */
export const RUNNER_META_TOOL_NAMES = new Set([
  ...PLAN_TOOL_NAMES,
  ...RESPONDER_TOOL_NAMES,
]);

export const MCP_AGENT_TOOL_NAMES = new Set([
  "mcp.list",
  "mcp.tools",
  "mcp.enable",
  "mcp.connect",
  "mcp.login",
]);

export function mcpAgentToolNames(askMode: boolean): string[] {
  const readOnly = ["mcp.list", "mcp.tools"];
  return askMode
    ? readOnly
    : [...readOnly, "mcp.enable", "mcp.connect", "mcp.login"];
}

/** Meta tools with no registry handler (runner-owned + ask-mode handoff). */
export const NON_REGISTRY_TOOL_NAMES = new Set([
  ...RUNNER_META_TOOL_NAMES,
  ...MCP_AGENT_TOOL_NAMES,
  "agent.handoff",
  "loop.reset",
]);

const byWire = new Map<string, ToolDefinition>();
for (const d of TOOL_DEFINITIONS) {
  byWire.set(d.wireName, d);
  const snake = toSnakeWireName(d.name);
  if (snake !== d.wireName) byWire.set(snake, d);
}

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return byName.get(name) ?? byWire.get(name);
}

export function wireNameFor(canonical: string): string {
  return byName.get(canonical)?.wireName ?? toWireName(canonical);
}

export function canonicalNameFor(wire: string): string | undefined {
  return byWire.get(wire)?.name;
}
