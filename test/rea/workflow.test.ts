import { describe, expect, it } from "vitest";
import type { ReaAvailability, ReaEngine } from "../../src/rea/availability.js";
import { dropSectionsAlreadyInHistory } from "../../src/agent/turn/setup/turn-messages.js";
import { REA_WORKFLOW, reaEngineLine, reaWorkflowContext } from "../../src/rea/workflow.js";

const engine = (id: string, ready: boolean, code = "not_configured"): ReaEngine => ({ id, name: id, ready, code: ready ? undefined : code, reason: undefined, failed: [], java: undefined });
const availability = (...engines: ReaEngine[]): ReaAvailability => ({ engines, open: new Set(["inspect_macho"]), deep: new Set(["search_procedures"]), blocked: new Set(), blockedGroups: [] });
const tools = [
  { toolName: "inspect_macho", destructive: false, inputSchema: { type: "object", properties: {}, required: [] } },
  { toolName: "search_procedures", destructive: false, inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] } },
];

describe("REA engine line", () => {
  it("is absent until REA has reported its engines", () => {
    expect(reaEngineLine(undefined)).toBe("");
    expect(reaEngineLine(availability())).toBe("");
  });

  it("tells the model to stop using engine tools and send the user to /rea engines when none is ready", () => {
    const line = reaEngineLine(availability(engine("ghidra", false), engine("hopper", false, "executable_missing")));
    expect(line).toBe("ENGINE: none ready (ghidra: not_configured; hopper: executable_missing). ^ tools fail with provider_unavailable until the user runs /rea engines; do not call or retry them.");
    expect(line.split("\n")).toHaveLength(1);
  });

  it("warns about universal Mach-O files only when every ready engine needs a thin slice", () => {
    expect(reaEngineLine(availability(engine("ghidra", true)))).toBe("ENGINE: ghidra ready. Universal Mach-O files must be thinned to one slice first.");
    expect(reaEngineLine(availability(engine("ghidra", true), engine("kuna", true)))).toContain("thinned");
    expect(reaEngineLine(availability(engine("ghidra", true), engine("hopper", true)))).toBe("ENGINE: ghidra, hopper ready.");
    expect(reaEngineLine(availability(engine("hopper", true), engine("ghidra", false)))).toBe("ENGINE: hopper ready.");
    expect(reaEngineLine(availability(engine("ida", true)))).toBe("ENGINE: ida ready.");
  });
});

describe("REA workflow text", () => {
  it("teaches the open-then-inspect flow, universal binaries and who installs engines", () => {
    for (const phrase of [
      "call open_binary(path) once",
      "Tools marked # then act on the open target and take no path argument",
      "never pass path to a # tool",
      "target_unavailable means open_binary first",
      "mach-o-universal",
      "lipo <path> -thin <arch> -output <scratch dir>/<name>-<arch>",
      "Hopper opens universal files itself",
      "tools marked ^",
      "Tools marked % need a prerequisite",
      "tell the user to run /rea engines",
      "never install or configure one yourself",
      "continue with # tools that lack ^",
    ]) {
      expect(REA_WORKFLOW).toContain(phrase);
    }
    expect(REA_WORKFLOW).not.toContain("Do not install engines");
    expect(REA_WORKFLOW.length).toBeLessThan(5_000);
  });

  it("assembles workflow, engine line and marked index in that order", () => {
    const context = reaWorkflowContext(undefined, tools as never, availability(engine("ghidra", false)));
    const parts = context.split("\n");
    const engineAt = parts.findIndex((line) => line.startsWith("ENGINE:"));
    const indexAt = parts.findIndex((line) => line.startsWith("REA TOOLS ("));
    expect(parts[0]).toBe("REA WORKFLOW");
    expect(engineAt).toBeGreaterThan(0);
    expect(indexAt).toBe(engineAt + 1);
    expect(context).toContain("inspect_macho#");
    expect(context).toContain("search_procedures(pattern)^");
  });

  it("is byte-identical for the same connection so a repeated enable cannot disturb the prompt cache", () => {
    const first = reaWorkflowContext(undefined, tools as never, availability(engine("ghidra", true)));
    expect(reaWorkflowContext(undefined, [...tools].reverse() as never, availability(engine("ghidra", true)))).toBe(first);
  });

  it("falls back to the unmarked index without availability", () => {
    const context = reaWorkflowContext(undefined, tools as never);
    expect(context).not.toContain("ENGINE:");
    expect(context).toContain("search_procedures(pattern)");
    expect(context).not.toContain("#^");
  });
});

describe("REA context across turns", () => {
  const section = (content: string) => ({ kind: "focus" as const, content, mandatory: true });
  const outcome = { kind: "outcome" as const, content: "OUTCOME CONTRACT", mandatory: true };
  const history = (content: string) => [{ role: "user" as const, content }];

  it("is not repeated while it is unchanged", () => {
    const context = reaWorkflowContext(undefined, tools as never, availability(engine("ghidra", false)));
    const kept = dropSectionsAlreadyInHistory([section(context), outcome], history(`REQUEST CONTEXT\n${context}`) as never, "next question");
    expect(kept.map((entry) => entry.content)).toEqual(["OUTCOME CONTRACT"]);
  });

  it("is sent again once after an engine install changes what the model should know", () => {
    const before = reaWorkflowContext(undefined, tools as never, availability(engine("ghidra", false)));
    const after = reaWorkflowContext(undefined, tools as never, availability(engine("ghidra", true)));
    expect(after).not.toBe(before);
    const kept = dropSectionsAlreadyInHistory([section(after), outcome], history(before) as never, "next question");
    expect(kept.map((entry) => entry.content)).toEqual([after, "OUTCOME CONTRACT"]);
  });
});

