import { describe, expect, it } from "vitest";
import { clonePlain } from "../../src/llm/plain-clone.js";
import type { ChatMessage } from "../../src/types.js";

describe("clonePlain", () => {
  const message: ChatMessage = {
    role: "assistant",
    content: "Working on it",
    toolCalls: [{ id: "call-1", name: "fs.write", args: { path: "a.txt", content: "x".repeat(4096), nested: { list: [1, "two", null] } } }],
    reasoningBlock: { text: "thinking", signature: "sig" },
    images: [{ mediaType: "image/png", dataBase64: "QUJD", path: "/tmp/a.png" }],
  };

  it("copies every plain object and array so later mutation cannot reach the clone", () => {
    const copy = clonePlain(message);
    expect(copy).toEqual(message);
    expect(copy).not.toBe(message);
    expect(copy.toolCalls).not.toBe(message.toolCalls);
    expect(copy.toolCalls![0]).not.toBe(message.toolCalls![0]);
    expect(copy.toolCalls![0]!.args).not.toBe(message.toolCalls![0]!.args);
    expect(copy.images![0]).not.toBe(message.images![0]);
    message.toolCalls![0]!.args.path = "changed.txt";
    (message.toolCalls![0]!.args.nested as { list: unknown[] }).list.push("late");
    expect(copy.toolCalls![0]!.args.path).toBe("a.txt");
    expect((copy.toolCalls![0]!.args.nested as { list: unknown[] }).list).toEqual([1, "two", null]);
  });

  it("serializes byte-for-byte like structuredClone, preserving key order and undefined fields", () => {
    const source = { b: 1, a: { z: "z", y: undefined, x: [{ k: "v" }] }, c: "text" };
    expect(JSON.stringify(clonePlain(source))).toBe(JSON.stringify(structuredClone(source)));
    expect(Object.keys(clonePlain(source).a)).toEqual(["z", "y", "x"]);
  });

  it("keeps an own __proto__ key as data instead of changing the prototype", () => {
    const parsed = JSON.parse('{"__proto__":{"polluted":true},"safe":1}') as Record<string, unknown>;
    const copy = clonePlain(parsed);
    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.keys(copy)).toEqual(["__proto__", "safe"]);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(parsed));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("shares values that are not plain data instead of reshaping them", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const when = new Date(0);
    const copy = clonePlain({ bytes, when });
    expect(copy.bytes).toBe(bytes);
    expect(copy.when).toBe(when);
  });
});
