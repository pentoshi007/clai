import { describe, expect, it } from "vitest";
import {
  MCP_FIELD_DESCRIPTION_CHARS,
  compactDescription,
  compactToolSchema,
} from "../../src/mcp/schema-compact.js";
import type { JsonSchemaObject } from "../../src/types.js";
import { normalizeToolResult, toToolMetadata } from "../../src/mcp/results.js";

describe("compactDescription", () => {
  it("collapses whitespace and keeps short text verbatim", () => {
    expect(compactDescription("  list\n  commits  ", 50)).toBe("list commits");
  });

  it("cuts on a sentence boundary and marks the elision", () => {
    const text = `${"a".repeat(30)}. ${"b".repeat(60)}`;
    const compacted = compactDescription(text, 40);
    expect(compacted).toBe(`${"a".repeat(30)}.…`);
  });

  it("falls back to a word boundary when no sentence fits", () => {
    const compacted = compactDescription("alpha beta gamma delta", 12);
    expect(compacted).toBe("alpha beta…");
    expect(compacted.length).toBeLessThanOrEqual(13);
  });
});

describe("compactToolSchema", () => {
  it("preserves root references, alternatives, dependencies, and typed additional properties", () => {
    const schema = {
      $ref: "#/$defs/Input",
      $defs: {
        Input: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
      oneOf: [{ required: ["id"] }, { required: ["name"] }],
      dependentRequired: { id: ["name"] },
      additionalProperties: { type: "string" },
    };
    const metadata = toToolMetadata(
      "docs",
      { name: "lookup", inputSchema: schema },
      "mcp_docs_lookup",
    );
    const compact = compactToolSchema(metadata.inputSchema);
    expect(compact.$ref).toBe(schema.$ref);
    expect(compact.$defs).toEqual(schema.$defs);
    expect(compact.oneOf).toEqual(schema.oneOf);
    expect(compact.dependentRequired).toEqual(schema.dependentRequired);
    expect(compact.additionalProperties).toEqual({ type: "string" });
  });
  it("drops documentation noise, bounds descriptions, and orders keywords", () => {
    const schema = {
      type: "object",
      properties: {
        owner: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          title: "Owner",
          examples: ["octocat"],
          description: "x".repeat(MCP_FIELD_DESCRIPTION_CHARS + 50),
          type: "string",
        },
        page: {
          deprecated: false,
          type: "number",
          default: 1,
          additionalProperties: true,
        },
      },
      required: ["owner", "ghost"],
      additionalProperties: false,
    } as unknown as JsonSchemaObject;

    const compacted = compactToolSchema(schema);
    const owner = compacted.properties.owner as Record<string, unknown>;

    expect(Object.keys(owner)).toEqual(["type", "description"]);
    expect(String(owner.description)).toHaveLength(MCP_FIELD_DESCRIPTION_CHARS + 1);
    expect(compacted.properties.page).toEqual({ type: "number", default: 1 });
    expect(compacted.required).toEqual(["owner", "ghost"]);
    expect(compacted.additionalProperties).toBe(false);
    expect(JSON.stringify(compacted).length).toBeLessThan(JSON.stringify(schema).length);
  });

  it("recurses into nested schema positions without reordering property maps", () => {
    const schema = {
      type: "object",
      properties: {
        filters: {
          type: "array",
          items: {
            type: "object",
            title: "Filter",
            properties: {
              zulu: { type: "string", title: "Zulu" },
              alpha: { type: "string", examples: ["a"] },
            },
          },
        },
        mode: {
          anyOf: [{ type: "string", enum: ["fast", "slow"], title: "Mode" }, { type: "null" }],
        },
      },
    } as unknown as JsonSchemaObject;

    const compacted = compactToolSchema(schema);
    const items = (compacted.properties.filters as Record<string, unknown>).items as Record<
      string,
      unknown
    >;
    const nested = items.properties as Record<string, unknown>;
    const mode = compacted.properties.mode as Record<string, unknown>;

    expect(Object.keys(items)).toEqual(["type", "properties"]);
    expect(Object.keys(nested)).toEqual(["zulu", "alpha"]);
    expect(nested.zulu).toEqual({ type: "string" });
    expect((mode.anyOf as unknown[])[0]).toEqual({
      type: "string",
      enum: ["fast", "slow"],
    });
  });

  it("produces identical output for keyword-reordered input", () => {
    const left = {
      type: "object",
      properties: {
        id: { type: "string", description: "identifier" },
      },
      required: ["id"],
    } as JsonSchemaObject;
    const right = {
      type: "object",
      properties: {
        id: { description: "identifier", type: "string" },
      },
      required: ["id"],
    } as JsonSchemaObject;

    expect(JSON.stringify(compactToolSchema(left))).toBe(JSON.stringify(compactToolSchema(right)));
  });

  it("keeps an empty schema empty", () => {
    expect(compactToolSchema({ type: "object", properties: {} })).toEqual({
      type: "object",
      properties: {},
    });
  });
});

describe("MCP result fidelity", () => {
  it("keeps structured data alongside a distinct text summary and resource links", () => {
    const result = normalizeToolResult({
      content: [
        { type: "text", text: "Found one issue" },
        {
          type: "resource_link",
          name: "Issue",
          uri: "https://example.com/issue/1",
          description: "Full details",
        },
      ],
      structuredContent: { id: 1, status: "open" },
    });
    expect(result.text).toContain("Found one issue");
    expect(result.text).toContain("https://example.com/issue/1 Full details");
    expect(result.text).toContain('{"id":1,"status":"open"}');
  });

  it("avoids repeating structured content already represented in a text block", () => {
    const result = normalizeToolResult({
      content: [{ type: "text", text: '{ "id": 1 }' }],
      structuredContent: { id: 1 },
    });
    expect(result.text).toBe('{ "id": 1 }');
  });
});
