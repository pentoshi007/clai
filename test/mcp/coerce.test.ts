import { describe, expect, it } from "vitest";
import { coerceArgumentsForSchema } from "../../src/mcp/coerce.js";

describe("coerceArgumentsForSchema", () => {
  it("parses JSON strings for object-typed arguments", () => {
    const schema = {
      type: "object",
      properties: {
        filter: { type: "object" },
        limit: { type: "number" },
        upsert: { type: "boolean" },
        name: { type: "string" },
      },
    };
    const { args, coerced } = coerceArgumentsForSchema(
      {
        filter: '{"_id":{"$oid":"abc"}}',
        limit: "5",
        upsert: "true",
        name: "orders",
      },
      schema,
    );
    expect(args.filter).toEqual({ _id: { $oid: "abc" } });
    expect(args.limit).toBe(5);
    expect(args.upsert).toBe(true);
    expect(args.name).toBe("orders");
    expect(coerced.sort()).toEqual(["filter", "limit", "upsert"]);
  });

  it("parses array-typed JSON strings", () => {
    const schema = {
      type: "object",
      properties: { pipeline: { type: "array" } },
    };
    const { args, coerced } = coerceArgumentsForSchema(
      { pipeline: '[{"$match":{}}]' },
      schema,
    );
    expect(args.pipeline).toEqual([{ $match: {} }]);
    expect(coerced).toEqual(["pipeline"]);
  });

  it("leaves strings without schema type alone", () => {
    const schema = { type: "object", properties: { value: {} } };
    const { args, coerced } = coerceArgumentsForSchema({ value: "42" }, schema);
    expect(args.value).toBe("42");
    expect(coerced).toEqual([]);
  });

  it("does not coerce invalid JSON or numbers", () => {
    const schema = {
      type: "object",
      properties: {
        filter: { type: "object" },
        limit: { type: "number" },
      },
    };
    const { args, coerced } = coerceArgumentsForSchema(
      { filter: "{not json", limit: "not-a-number" },
      schema,
    );
    expect(args.filter).toBe("{not json");
    expect(args.limit).toBe("not-a-number");
    expect(coerced).toEqual([]);
  });

  it("coerces nested values inside objects and arrays", () => {
    const schema = {
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: { limit: { type: "integer" } },
        },
        docs: {
          type: "array",
          items: { type: "object", properties: { count: { type: "number" } } },
        },
      },
    };
    const { args, coerced } = coerceArgumentsForSchema(
      { options: { limit: "3" }, docs: [{ count: "1.5" }] },
      schema,
    );
    expect(args.options).toEqual({ limit: 3 });
    expect(args.docs).toEqual([{ count: 1.5 }]);
    expect(coerced).toEqual(["options.limit", "docs[0].count"]);
  });

  it("respects anyOf/oneOf union types", () => {
    const schema = {
      type: "object",
      properties: {
        query: { anyOf: [{ type: "string" }, { type: "object" }] },
      },
    };
    const { args } = coerceArgumentsForSchema({ query: '{"a":1}' }, schema);
    expect(args.query).toEqual({ a: 1 });
  });

  it("keeps original object when nothing coerced", () => {
    const input = { a: "b" };
    const { args } = coerceArgumentsForSchema(input, { type: "object" });
    expect(args).toBe(input);
  });
});
