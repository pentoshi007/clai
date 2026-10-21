import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalizeTurnCall } from "../../src/agent/turn/loop/canonicalize-turn-call.js";
import { argumentHint, isArgumentRejection } from "../../src/mcp/argument-hint.js";
import { manageRea } from "../../src/rea/runtime.js";
import { REA_SERVER } from "../../src/rea/workflow.js";
import { reaTestRuntime, seedRea } from "../helpers/rea-runtime.js";

const strict = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS = [
  { name: "discover_webmcp_tools", description: "Discover WebMCP tools exposed by a page", inputSchema: strict({ url: { type: "string" } }, ["url"]) },
  { name: "open_binary", description: "Open a binary for analysis", inputSchema: strict({ path: { type: "string" } }, ["path"]) },
  { name: "inspect_artifact", description: "Inspect an artifact", inputSchema: strict({ path: { type: "string" }, detail: { enum: ["summary", "complete"] } }, ["path"]) },
];

const rejectUnknown = (_name: string, args: Record<string, unknown>): object =>
  "detail" in args && _name === "open_binary"
    ? { isError: true, content: [{ type: "text", text: "Invalid arguments: Unrecognized key(s) in object: 'detail'" }] }
    : _name === "inspect_artifact" && args.path === "/missing"
      ? { isError: true, content: [{ type: "text", text: "ENOENT: no such file" }] }
      : { content: [{ type: "text", text: "ok" }] };

let root: string;
let host: ReturnType<typeof reaTestRuntime>;
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "clai-rea-resolve-"));
  host = reaTestRuntime(root, { tools: TOOLS, respond: rejectUnknown });
  seedRea();
  await manageRea(host.runtime, "enable");
});
afterEach(async () => {
  await host.runtime.closeAll();
  rmSync(root, { recursive: true, force: true });
});

describe("REA tool-call resolution", () => {
  it("keeps client-owned mcp tools even when a server tool ends with the same words", () => {
    for (const name of ["mcp.tools", "mcp.list", "mcp.call", "rea.manage"]) {
      expect(canonicalizeTurnCall({ id: "1", name, args: {} }, host.runtime).name).toBe(name);
    }
  });

  it("maps a bare or server-qualified REA tool name to its canonical name", () => {
    for (const name of ["open_binary", "clai-rea.open_binary", `mcp.${REA_SERVER}.open_binary`]) {
      expect(canonicalizeTurnCall({ id: "1", name, args: { path: "/a" } }, host.runtime).name).toBe(`mcp.${REA_SERVER}.open_binary`);
    }
  });

  it("unwraps mcp.call for exact, server-qualified and bare tool names", () => {
    for (const name of [`mcp.${REA_SERVER}.open_binary`, `${REA_SERVER}.open_binary`, "open_binary"]) {
      const call = canonicalizeTurnCall({ id: "1", name: "mcp.call", args: { name, arguments: { path: "/a" } } }, host.runtime);
      expect(call).toMatchObject({ name: `mcp.${REA_SERVER}.open_binary`, args: { path: "/a" } });
    }
  });

  it("leaves mcp.call untouched for an unknown tool", () => {
    const call = canonicalizeTurnCall({ id: "1", name: "mcp.call", args: { name: "open_binary_v2", arguments: { path: "/a" } } }, host.runtime);
    expect(call).toMatchObject({ name: "mcp.call", args: { name: "open_binary_v2", arguments: { path: "/a" } } });
  });

  it("does not guess when a bare name is ambiguous across servers", async () => {
    mkdirSync(join(root, ".clai"));
    writeFileSync(join(root, ".clai", "mcp.json"), JSON.stringify({ servers: { docs: { command: "docs" } } }));
    await host.runtime.refresh();
    expect(host.runtime.getTool("open_binary")).toBeUndefined();
    expect(host.runtime.getTool(`${REA_SERVER}.open_binary`)?.canonicalName).toBe(`mcp.${REA_SERVER}.open_binary`);
    const call = canonicalizeTurnCall({ id: "1", name: "mcp.call", args: { name: "open_binary", arguments: { path: "/a" } } }, host.runtime);
    expect(call).toMatchObject({ name: "mcp.call", args: { name: "open_binary" } });
  });

  it("appends the accepted arguments when a strict schema rejects a remembered option", async () => {
    const rejected = await host.runtime.callTool(`mcp.${REA_SERVER}.open_binary`, { path: "/a", detail: "summary" });
    expect(rejected.ok).toBe(false);
    expect(rejected.output).toContain("Unrecognized key(s)");
    expect(rejected.output).toContain(`Accepted arguments for mcp.${REA_SERVER}.open_binary: path (required).`);
  });

  it("does not append argument advice to an ordinary tool failure", async () => {
    const failed = await host.runtime.callTool(`mcp.${REA_SERVER}.inspect_artifact`, { path: "/missing" });
    expect(failed.ok).toBe(false);
    expect(failed.output).toContain("ENOENT");
    expect(failed.output).not.toContain("Accepted arguments");
  });
});

describe("argument advice", () => {
  const tool = (properties: Record<string, unknown>, required: string[] = []) => ({
    canonicalName: "mcp.s.t",
    inputSchema: { type: "object" as const, properties, required },
  }) as unknown as Parameters<typeof argumentHint>[0];

  it("recognises validation rejections and nothing else", () => {
    for (const text of ["Unrecognized key(s) in object: 'detail'", "unknown argument foo", "Invalid arguments: x", "missing required field path", "must NOT have additional properties"]) {
      expect(isArgumentRejection(text)).toBe(true);
    }
    for (const text of ["ENOENT: no such file", "connection refused", "timed out after 600s"]) {
      expect(isArgumentRejection(text)).toBe(false);
    }
  });

  it("lists required and optional names, and caps long lists", () => {
    expect(argumentHint(tool({}))).toBe("mcp.s.t takes no arguments.");
    expect(argumentHint(tool({ a: {}, b: {} }, ["a"]))).toContain("a (required), b.");
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, {}]));
    expect(argumentHint(tool(many))).toContain("… 6 more");
  });
});
