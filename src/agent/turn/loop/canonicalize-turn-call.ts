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
  const canonicalMcpName = mcpRuntime?.canonicalizeToolName(normalized.name);
  const named =
    canonicalMcpName && canonicalMcpName !== normalized.name
      ? { ...normalized, name: canonicalMcpName }
      : normalized;
  const args = stripSupersededElidedArgs(named.args);
  return args === named.args ? named : { ...named, args };
};
