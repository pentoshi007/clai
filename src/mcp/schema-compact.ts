import type { JsonSchemaObject } from "../types.js";

export const MCP_TOOL_DESCRIPTION_CHARS = 600;
export const MCP_FIELD_DESCRIPTION_CHARS = 200;

const MAX_DEPTH = 10;

const DROPPED_KEYWORDS = new Set([
  "$anchor",
  "$comment",
  "$dynamicAnchor",
  "$dynamicRef",
  "$id",
  "$schema",
  "contentEncoding",
  "contentMediaType",
  "deprecated",
  "example",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "patternProperties",
  "properties",
]);

const SCHEMA_LIST_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

const SCHEMA_NODE_KEYWORDS = new Set([
  "additionalProperties",
  "contains",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
]);

const OPAQUE_KEYWORDS = new Set(["const", "default", "enum", "required"]);

const KEYWORD_ORDER = [
  "$ref",
  "type",
  "description",
  "enum",
  "const",
  "default",
  "format",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "items",
  "prefixItems",
  "properties",
  "required",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "additionalProperties",
  "$defs",
  "definitions",
];

const KEYWORD_RANK = new Map(
  KEYWORD_ORDER.map((keyword, index) => [keyword, index]),
);

function rankOf(keyword: string): number {
  return KEYWORD_RANK.get(keyword) ?? KEYWORD_ORDER.length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compactDescription(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  const window = collapsed.slice(0, maxChars);
  const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("; "));
  const word = window.lastIndexOf(" ");
  const cut =
    sentence >= Math.floor(maxChars / 2) ? sentence + 1 : word > 0 ? word : maxChars;
  return `${collapsed.slice(0, cut).trimEnd()}…`;
}

function compactSchemaNode(value: unknown, depth: number): unknown {
  if (depth >= MAX_DEPTH || !isRecord(value)) return value;
  const compacted = new Map<string, unknown>();
  for (const [keyword, entry] of Object.entries(value)) {
    if (DROPPED_KEYWORDS.has(keyword)) continue;
    if (keyword === "description") {
      if (typeof entry !== "string") continue;
      const description = compactDescription(entry, MCP_FIELD_DESCRIPTION_CHARS);
      if (description.length > 0) compacted.set(keyword, description);
      continue;
    }
    if (keyword === "additionalProperties" && entry === true) continue;
    if (OPAQUE_KEYWORDS.has(keyword)) {
      compacted.set(keyword, entry);
      continue;
    }
    if (SCHEMA_MAP_KEYWORDS.has(keyword) && isRecord(entry)) {
      const members: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(entry)) {
        members[name] = compactSchemaNode(member, depth + 1);
      }
      compacted.set(keyword, members);
      continue;
    }
    if (SCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(entry)) {
      compacted.set(
        keyword,
        entry.map((member) => compactSchemaNode(member, depth + 1)),
      );
      continue;
    }
    if (SCHEMA_NODE_KEYWORDS.has(keyword)) {
      compacted.set(keyword, compactSchemaNode(entry, depth + 1));
      continue;
    }
    compacted.set(keyword, entry);
  }
  const ordered: Record<string, unknown> = {};
  for (const keyword of [...compacted.keys()].sort((left, right) => {
    const delta = rankOf(left) - rankOf(right);
    return delta === 0 ? left.localeCompare(right) : delta;
  })) {
    ordered[keyword] = compacted.get(keyword);
  }
  return ordered;
}

export function compactToolSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const properties: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(schema.properties)) {
    properties[name] = compactSchemaNode(value, 0);
  }
  const required = (schema.required ?? []).filter(
    (name) => name in properties,
  );
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...(schema.additionalProperties === false
      ? { additionalProperties: false }
      : {}),
  };
}
