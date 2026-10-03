import { describe, expect, it } from "vitest";
import { toolCheckHandler } from "../../src/tools/capabilities.js";
import { getToolDefinition } from "../../src/tools/definitions.js";

describe("tool.check", () => {
  it("schema requires tools (not name/binary)", () => {
    const def = getToolDefinition("tool.check")!;
    expect(def.parameters.required).toEqual(["tools"]);
    expect(def.parameters.properties.tools).toBeDefined();
    expect(def.parameters.properties.name).toBeUndefined();
  });

  it.each([21, 40])("accepts a batch of %s tools", async (count) => {
    const tools = Array.from({ length: count }, (_, index) => `clai_missing_tool_${index}`);
    const result = await toolCheckHandler({ tools });
    expect(result.ok).toBe(true);
    expect(result.output.match(/^✗ clai_missing_tool_/gm)).toHaveLength(count);
    expect(getToolDefinition("tool.check")!.parameters.properties.tools).toMatchObject({ maxItems: 40 });
  });

  it("rejects more than 40 tools", async () => {
    const result = await toolCheckHandler({ tools: Array.from({ length: 41 }, () => "node") });
    expect(result.ok).toBe(false);
    expect(result.output).toBe("tool.check accepts at most 40 tools per call.");
  });

  it("accepts tools array", async () => {
    const result = await toolCheckHandler({ tools: ["node"] });
    expect(result.output).toMatch(/node/i);
  });

  it("accepts tools comma string", async () => {
    const result = await toolCheckHandler({ tools: "node" });
    expect(result.output).toMatch(/node/i);
  });

  it("accepts name alias (model mistake from old schema)", async () => {
    // Was: {"name":"nmap"} which previously failed hard.
    const result = await toolCheckHandler({ name: "node" });
    expect(result.output).toMatch(/node/i);
    expect(result.output).not.toMatch(/expects \{ "tools"/);
  });

  it("accepts binary alias", async () => {
    const result = await toolCheckHandler({ binary: "node" });
    expect(result.output).toMatch(/node/i);
  });

  it("rejects empty args", async () => {
    const result = await toolCheckHandler({});
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/tools/i);
  });

  it("does not treat project-local node_modules vite as global available", async () => {
    // Even if cwd is a project with vite in node_modules/.bin, tool.check
    // must not report global success from that path alone.
    const result = await toolCheckHandler({ tools: ["vite"] });
    if (result.output.includes("✓ vite")) {
      expect(result.output).not.toMatch(/node_modules\/\.bin/i);
    } else {
      // Optional local CLI: soft miss (○) still overall ok when alone… actually
      // only vite missing is optional so ok=true with ○ line.
      expect(result.output).toMatch(/not on global PATH|○ vite/i);
      expect(result.ok).toBe(true);
    }
  });

  it("node+npm succeed even when vite is only optional/missing", async () => {
    const result = await toolCheckHandler({
      tools: ["node", "npm", "vite"],
    });
    expect(result.output).toMatch(/✓ node/i);
    expect(result.output).toMatch(/✓ npm/i);
    // vite may be ○ optional or ✓ global — overall must not hard-fail solely on vite
    if (!/✓ vite/i.test(result.output)) {
      expect(result.output).toMatch(/○ vite|not on global PATH/i);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    }
  });

  it("node+npm succeed when yarn is missing (alternate package manager)", async () => {
    const result = await toolCheckHandler({
      tools: ["node", "npm", "yarn"],
    });
    expect(result.output).toMatch(/✓ node/i);
    expect(result.output).toMatch(/✓ npm/i);
    // yarn often missing — must be soft ○, overall ok
    if (!/✓ yarn/i.test(result.output)) {
      expect(result.output).toMatch(/○ yarn/i);
      expect(result.ok).toBe(true);
      expect(result.exitCode).toBe(0);
    }
  });
});
