import type { ToolCall } from "../../../types.js";
import { normalizeToolCall } from "../../../tools/registry.js";
import { stripSupersededElidedArgs } from "../../message-slim.js";

export type ToolNameCanonicalizer = {
  canonicalizeToolName(name: string): string;
};

export const canonicalizeTurnCall = (
  rawCall: ToolCall,
  mcpRuntime?: ToolNameCanonicalizer | undefined,
): ToolCall => {
  const normalized = normalizeToolCall(rawCall);
  const mcpCall = unwrapMcpCall(normalized);
  const canonicalMcpName = mcpRuntime?.canonicalizeToolName(mcpCall.name);
  const named =
    canonicalMcpName && canonicalMcpName !== mcpCall.name
      ? { ...mcpCall, name: canonicalMcpName }
      : mcpCall;
  const args = stripSupersededElidedArgs(named.args);
  return args === named.args ? named : { ...named, args };
};

const unwrapMcpCall = (call: ToolCall): ToolCall => {
  if (call.name !== "mcp.call") return call;
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
  return { ...call, name, args: arguments_ as Record<string, unknown> };
};
