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
    subagents: false,
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

  it.each([false, true])("keeps every permitted tool when compact=%s", (mcpPresent) => {
    const route = routing({ mcpPresent });
    const full = route.selectToolDefs(true, false, "nvidia", "test-model")!;
    const compact = route.selectToolDefs(true, true, "nvidia", "test-model")!;
    expect(JSON.stringify(compact)).toBe(JSON.stringify(full));
    expect(full.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(route.routeToolNames("nvidia", "test-model")),
    );
    expect(full.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["fs.replaceLines", "shell.wait", "plan.clear", "terminal.send"]),
    );
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

  it.each([false, true])("pins the initial compact=%s choice across turn budgets", (initial) => {
    const compactPromptModes = new Map<string, boolean>();
    const first = routing({
      compactPromptModes,
      useCompactSystemPrompt: () => initial,
    }).buildStableSystemContent(true, "nvidia", "test-model");
    const second = routing({
      compactPromptModes,
      useCompactSystemPrompt: () => !initial,
    }).buildStableSystemContent(true, "nvidia", "test-model");
    expect(second).toBe(first);
    expect(first.includes("Professional execution method — applies to every domain")).toBe(!initial);
  });

  it.each([
    { native: true, compact: false },
    { native: true, compact: true },
    { native: false, compact: false },
    { native: false, compact: true },
  ])("sends subagent tools and policy only while orchestration is on (%o)", ({ native, compact }) => {
    const route = (subagents: boolean) => routing({
      subagents,
      toolCalling: native ? "native" : "text",
      useCompactSystemPrompt: () => compact,
    });
    const off = route(false);
    const on = route(true);
    expect(off.routeToolNames("nvidia", "test-model").some((name) => name.startsWith("subagent."))).toBe(false);
    expect(on.routeToolNames("nvidia", "test-model")).toContain("subagent.start");
    expect(off.buildStableSystemContent(native, "nvidia", "test-model")).not.toMatch(/subagent\./);
    expect(on.buildStableSystemContent(native, "nvidia", "test-model")).toMatch(/subagent\./);
    if (native) {
      const names = off.selectToolDefs(true, compact, "nvidia", "test-model")?.map((definition) => definition.name);
      expect(names?.some((name) => name.startsWith("subagent."))).toBe(false);
    }
  });

  it.each([
    { native: true, compact: false },
    { native: true, compact: true },
    { native: false, compact: false },
    { native: false, compact: true },
  ])("reports whether the stable prompt carries the execution rules (%o)", ({ native, compact }) => {
    const route = routing({
      toolCalling: native ? "native" : "text",
      useCompactSystemPrompt: () => compact,
    });
    const system = route.buildStableSystemContent(native, "nvidia", "test-model");
    expect(route.stableSystemIncludesExecutionRules("nvidia", "test-model")).toBe(!compact);
    expect(system.includes("Professional execution method — applies to every domain")).toBe(!compact);
  });
});
