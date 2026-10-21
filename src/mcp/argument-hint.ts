import type { McpToolMetadata } from "./types.js";

const MAX_LISTED_ARGUMENTS = 24;
const ARGUMENT_REJECTION =
  /unrecognized keys?|unknown (?:argument|key|parameter|property)|additional propert|invalid arguments|input validation|invalid input|missing required|required property/i;

export function isArgumentRejection(output: string): boolean {
  return ARGUMENT_REJECTION.test(output);
}

export function argumentHint(tool: McpToolMetadata): string {
  const names = Object.keys(tool.inputSchema.properties);
  if (names.length === 0) return `${tool.canonicalName} takes no arguments.`;
  const required = new Set(tool.inputSchema.required ?? []);
  const listed = names
    .slice(0, MAX_LISTED_ARGUMENTS)
    .map((name) => (required.has(name) ? `${name} (required)` : name));
  const rest = names.length > MAX_LISTED_ARGUMENTS ? `, … ${names.length - MAX_LISTED_ARGUMENTS} more` : "";
  return `Accepted arguments for ${tool.canonicalName}: ${listed.join(", ")}${rest}. Pass only these names; read exact types with mcp.tools.`;
}
