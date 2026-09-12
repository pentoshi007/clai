import type { ToolCall } from "../../../types.js";
import { normalizeToolCall } from "../../../tools/registry.js";
import { stripSupersededElidedArgs } from "../../message-slim.js";

export type ToolNameCanonicalizer = {
  canonicalizeToolName(name: string): string;
  getTool?(name: string): { canonicalName: string; wireName: string } | undefined;
};

export const canonicalizeTurnCall = (
  rawCall: ToolCall,
  mcpRuntime?: ToolNameCanonicalizer | undefined,
): ToolCall => {
  const normalized = normalizeToolCall(rawCall);
  if (normalized.name === "mcp.call") return unwrapMcpCall(normalized, mcpRuntime);
  const canonicalMcpName = mcpRuntime?.canonicalizeToolName(normalized.name);
  const named =
    canonicalMcpName && canonicalMcpName !== normalized.name
      ? { ...normalized, name: canonicalMcpName }
      : normalized;
  const args = stripSupersededElidedArgs(named.args);
  return args === named.args ? named : { ...named, args };
};

const unwrapMcpCall = (
  call: ToolCall,
  mcpRuntime?: ToolNameCanonicalizer,
): ToolCall => {
  const name = call.args.name;
  const arguments_ = call.args.arguments;
  if (
    typeof name !== "string" ||
    !arguments_ ||
    typeof arguments_ !== "object" ||
    Array.isArray(arguments_)
  ) {
    return call;
  }
  const tool = mcpRuntime?.getTool?.(name);
  if (!tool || (tool.canonicalName !== name && tool.wireName !== name)) return call;
  return {
    ...call,
    name: tool.canonicalName,
    args: stripSupersededElidedArgs(arguments_ as Record<string, unknown>),
  };
};
