import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../../src/types.js";
import { availableToolNames } from "../../src/tools/registry.js";
import { RUNNER_META_TOOL_NAMES } from "../../src/tools/definitions.js";
import {
  createToolRouting,
  type ToolRoutingInput,
} from "../../src/agent/turn/tool-routing.js";

const mcpDefinition: ToolDefinition = {
  name: "mcp.docs.search",
  description: "search docs",
  parameters: { type: "object", properties: {} },
};

const routing = (overrides: Partial<ToolRoutingInput> = {}) =>
  createToolRouting({
    mode: "agent",
    mcpPresent: false,
    mcpToolNames: [],
    mcpToolDefinitions: [],
    imageOcrEnabled: false,
    skillsAvailable: false,
    toolCalling: "auto",
    useCompactSystemPrompt: () => false,
    ...overrides,
  });

describe("tool routing", () => {
  it("filters capability-gated names and keeps the registry order", () => {
    const gatedOff = routing().routeToolNames("nvidia", "test-model");
    expect(gatedOff).not.toContain("image.ocr");
    expect(gatedOff).not.toContain("skill.load");
    expect(gatedOff).not.toContain("skill.list");

    const gatedOn = routing({
      imageOcrEnabled: true,
      skillsAvailable: true,
    }).routeToolNames("nvidia", "test-model");
    expect(gatedOn).toContain("skill.load");
    expect(gatedOn).toContain("skill.list");
    if (availableToolNames().includes("image.ocr")) {
      expect(gatedOn).toContain("image.ocr");
    }
  });

  it("appends mcp tool names and agent tools only when a runtime exists", () => {
    const withoutRuntime = routing({
      mcpToolNames: ["mcp.docs.search"],
    }).routeToolNames("nvidia", "test-model");
    expect(withoutRuntime).toContain("mcp.docs.search");
    expect(withoutRuntime).not.toContain("mcp.list");

    const withRuntime = routing({
      mcpPresent: true,
      mcpToolNames: ["mcp.docs.search"],
    }).routeToolNames("nvidia", "test-model");
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

  it("allows routed names plus runner meta tools and includes mcp definitions", () => {
    const defs = routing({
      mcpPresent: true,
      mcpToolNames: ["mcp.docs.search"],
      mcpToolDefinitions: [mcpDefinition],
    }).selectToolDefs(true, false, "nvidia", "test-model");

    expect(defs).toBeDefined();
    const names = defs!.map((definition) => definition.name);
    expect(names).toContain("mcp.docs.search");
    for (const name of names) {
      const routed = routing({
        mcpPresent: true,
        mcpToolNames: ["mcp.docs.search"],
      }).routeToolNames("nvidia", "test-model");
      expect(routed.includes(name) || RUNNER_META_TOOL_NAMES.has(name)).toBe(true);
    }
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
