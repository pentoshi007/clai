import { describe, expect, it } from "vitest";
import { availableToolNames } from "../../src/tools/registry.js";
import { RUNNER_META_TOOL_NAMES } from "../../src/tools/definitions.js";
import {
  createToolRouting,
  type ToolRoutingInput,
} from "../../src/agent/turn/tool-routing.js";

const routing = (overrides: Partial<ToolRoutingInput> = {}) =>
  createToolRouting({
    mode: "agent",
    mcpPresent: false,
    toolCalling: "auto",
    useCompactSystemPrompt: () => false,
    ...overrides,
  });

describe("tool routing", () => {
  it("keeps the tool list independent of skill availability so the cache prefix stays stable", () => {
    const names = routing().routeToolNames("nvidia", "test-model");
    if (availableToolNames().includes("image.ocr")) {
      expect(names).toContain("image.ocr");
    }
    expect(names).toContain("skill.load");
    expect(names).toContain("skill.list");

    const withSkills = routing().routeToolNames("nvidia", "test-model");
    expect(withSkills).toContain("skill.load");
    expect(withSkills).toContain("skill.list");
    if (availableToolNames().includes("image.ocr")) {
      expect(withSkills).toContain("image.ocr");
    }
  });

  it("adds the stable MCP wrapper and controls only when a runtime exists", () => {
    const withoutRuntime = routing().routeToolNames("nvidia", "test-model");
    expect(withoutRuntime).not.toContain("mcp.call");
    expect(withoutRuntime).not.toContain("mcp.list");

    const withRuntime = routing({
      mcpPresent: true,
    }).routeToolNames("nvidia", "test-model");
    expect(withRuntime).toContain("mcp.call");
    expect(withRuntime).toContain("mcp.list");
  });

  it("reports the dialect and native flag together", () => {
    const native = routing().resolveNativeTools("nvidia", "test-model");
    expect(native.native).toBe(native.dialect !== "none");

    const textOnly = routing({ toolCalling: "text" }).resolveNativeTools(
      "nvidia",
      "test-model",
    );
    expect(textOnly.dialect).toBe("none");
    expect(textOnly.native).toBe(false);
  });

  it("omits definitions entirely when native tools are off", () => {
    expect(
      routing().selectToolDefs(false, false, "nvidia", "test-model"),
    ).toBeUndefined();
  });

  it("allows routed names plus runner meta tools and includes the MCP wrapper", () => {
    const defs = routing({
      mcpPresent: true,
    }).selectToolDefs(true, false, "nvidia", "test-model");

    expect(defs).toBeDefined();
    const names = defs!.map((definition) => definition.name);
    expect(names).toContain("mcp.call");
    for (const name of names) {
      const routed = routing({
        mcpPresent: true,
      }).routeToolNames("nvidia", "test-model");
      expect(routed.includes(name) || RUNNER_META_TOOL_NAMES.has(name)).toBe(true);
    }
  });

  it("retains the MCP wrapper in compact native tool sets", () => {
    const defs = routing({ mcpPresent: true }).selectToolDefs(
      true,
      true,
      "nvidia",
      "test-model",
    );
    expect(defs?.some((definition) => definition.name === "mcp.call")).toBe(true);
  });

  it("selects the compact constitution only when compact prompts are enabled", () => {
    const full = routing().buildStableSystemContent(
      true,
      "nvidia",
      "test-model",
    );
    const compact = routing({
      useCompactSystemPrompt: () => true,
    }).buildStableSystemContent(true, "nvidia", "test-model");

    expect(full.length).toBeGreaterThan(0);
    expect(compact.length).toBeGreaterThan(0);
    expect(compact).not.toBe(full);
  });
});
