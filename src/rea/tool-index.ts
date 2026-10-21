import type { McpToolMetadata } from "../mcp/types.js";

export const REA_INDEX_CHARS = 10_000;

const MIN_FAMILY_SIZE = 3;
const MAX_INLINE_ENUM_CHARS = 28;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_LITERAL = /^[A-Za-z0-9_.-]{1,24}$/;
const SHORT_TYPES: Readonly<Record<string, string>> = {
  integer: "int",
  number: "num",
  boolean: "bool",
  array: "arr",
  object: "obj",
};

type IndexedTool = Pick<McpToolMetadata, "toolName" | "inputSchema" | "destructive">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byName(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function typeSuffix(schema: unknown): string {
  if (!isRecord(schema)) return ":*";
  if (Array.isArray(schema.enum)) {
    const literals = schema.enum.map(String);
    const inline = literals.join("|");
    const plain = schema.enum.every((value) => ["string", "number", "boolean"].includes(typeof value)) &&
      literals.every((literal) => SAFE_LITERAL.test(literal));
    return plain && inline.length <= MAX_INLINE_ENUM_CHARS ? `:${inline}` : ":enum";
  }
  const types = (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(
    (type): type is string => typeof type === "string" && type !== "null",
  );
  if (types.length === 0) return ":*";
  if (types.length === 1) return types[0] === "string" ? "" : `:${SHORT_TYPES[types[0]!] ?? types[0]}`;
  return `:${types.map((type) => SHORT_TYPES[type] ?? type).join("|")}`;
}

function entry(tool: IndexedTool, withArguments: boolean): string {
  const properties = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  const required = Array.isArray(tool.inputSchema.required)
    ? tool.inputSchema.required.filter((name): name is string => typeof name === "string")
    : [];
  const args = withArguments && required.length > 0
    ? `(${required.map((name) => (SAFE_IDENTIFIER.test(name) ? `${name}${typeSuffix(properties[name])}` : "*")).join(",")})`
    : "";
  const flags = `${tool.destructive ? "!" : ""}${Object.hasOwn(properties, "detail") ? "~" : ""}`;
  return `${tool.toolName}${args}${flags}`;
}

function family(name: string): string {
  const separator = name.indexOf("_");
  return separator > 0 ? name.slice(0, separator) : "";
}

function lines(tools: readonly IndexedTool[], withArguments: boolean): string[] {
  const groups = new Map<string, string[]>();
  for (const tool of [...tools].sort((left, right) => byName(left.toolName, right.toolName))) {
    const key = family(tool.toolName);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry(tool, withArguments));
    else groups.set(key, [entry(tool, withArguments)]);
  }
  const named: Array<[string, string[]]> = [];
  const rest: string[] = [];
  for (const [key, items] of groups) {
    if (key !== "" && items.length >= MIN_FAMILY_SIZE) named.push([key, items]);
    else rest.push(...items);
  }
  named.sort((left, right) => right[1].length - left[1].length || byName(left[0], right[0]));
  const output = named.map(([key, items]) => `${key}: ${items.join(" ")}`);
  if (rest.length > 0) output.push(`other: ${rest.sort(byName).join(" ")}`);
  return output;
}

export function reaToolIndex(catalog: readonly IndexedTool[], limit = REA_INDEX_CHARS): string {
  const tools = catalog.filter((tool) => SAFE_IDENTIFIER.test(tool.toolName));
  if (tools.length === 0) return "";
  const header = `REA TOOLS (${tools.length}; mcp.call name=mcp.clai-rea.<name>): (x,y)=required arguments, strings unless typed; obj, arr, * and enum need the schema from mcp.tools; ~ accepts detail; ! changes state or the target`;
  for (const withArguments of [true, false]) {
    const body = lines(tools, withArguments).join("\n");
    if (header.length + body.length + 1 <= limit) return `${header}\n${body}`;
  }
  const names = lines(tools, false).join("\n");
  const room = Math.max(0, limit - header.length - 64);
  const cut = names.lastIndexOf(" ", room);
  return `${header}\n${names.slice(0, cut > 0 ? cut : room)} …more tools: use mcp.tools server="clai-rea" without a query`;
}
