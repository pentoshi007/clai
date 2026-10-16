import { describe, expect, it } from "vitest";
import { createToolRouting } from "../../src/agent/turn/tool-routing.js";
import { createPromptProfiles, parsePromptProfiles } from "../../src/prompts/profile-state.js";
import { bindPromptProfile, validateProfileArtifacts } from "../../src/prompts/profile-binding.js";
import { legacyPromptProfile } from "../../src/prompts/legacy-profile.js";

const booleans = [false, true];
const shapes = booleans.flatMap((compact) => booleans.flatMap((native) => booleans.flatMap((vision) => booleans.map((mcpPresent) => ({ compact, native, vision, mcpPresent })))));

describe("immutable legacy profile binding", () => {
  it.each(shapes)("preserves legacy prompt, ordered tools and explicit composition capability for %j", (shape) => {
    const provider = shape.vision ? "openai" : "nvidia";
    const model = shape.vision ? "gpt-4o" : "openai/gpt-oss-20b";
    const input = { mode: "agent" as const, mcpPresent: shape.mcpPresent, toolCalling: shape.native ? "native" as const : "text" as const, useCompactSystemPrompt: () => shape.compact };
    const legacy = createToolRouting(input);
    const state = createPromptProfiles();
    const bound = createToolRouting({ ...input, promptProfiles: state });
    expect(bound.buildStableSystemContent(shape.native, provider, model)).toBe(legacy.buildStableSystemContent(shape.native, provider, model));
    expect(bound.selectToolDefs(shape.native, shape.compact, provider, model)).toEqual(legacy.selectToolDefs(shape.native, shape.compact, provider, model));
    expect(bound.executionRulesInSystem(shape.native, provider, model)).toBe(!shape.compact);
    expect(state.bindings).toHaveLength(1);
    expect(state.bindings[0]?.profileDigest).toBe(legacyPromptProfile().digest);
    validateProfileArtifacts(parsePromptProfiles(JSON.parse(JSON.stringify(state)))!);
  });

  it("pins compact/reliability/catalog choices across restore and keeps native/text/provider route identities separate", () => {
    const state = createPromptProfiles();
    const original = process.env.CLAI_SLIM_NATIVE_PROMPT;
    process.env.CLAI_SLIM_NATIVE_PROMPT = "true";
    try {
      const first = createToolRouting({ mode: "agent", mcpPresent: true, toolCalling: "native", useCompactSystemPrompt: () => false, promptProfiles: state });
      const prompt = first.buildStableSystemContent(true, "openai", "gpt-4o");
      const tools = first.selectToolDefs(true, false, "openai", "gpt-4o");
      process.env.CLAI_SLIM_NATIVE_PROMPT = "false";
      const restored = parsePromptProfiles(JSON.parse(JSON.stringify(state)))!;
      const second = createToolRouting({ mode: "agent", mcpPresent: false, toolCalling: "native", useCompactSystemPrompt: () => true, promptProfiles: restored });
      expect(second.buildStableSystemContent(true, "openai", "gpt-4o")).toBe(prompt);
      expect(second.selectToolDefs(true, true, "openai", "gpt-4o")).toEqual(tools);
      second.buildStableSystemContent(false, "openai", "gpt-4o");
      second.buildStableSystemContent(true, "nvidia", "openai/gpt-oss-20b");
      expect(restored.bindings).toHaveLength(3);
      expect(second.buildStableSystemContent(true, "openai", "gpt-4o")).toBe(prompt);
    } finally {
      if (original === undefined) delete process.env.CLAI_SLIM_NATIVE_PROMPT;
      else process.env.CLAI_SLIM_NATIVE_PROMPT = original;
    }
  });

  it("isolates mutable caller definitions and freezes internal nested artifacts", () => {
    const state = createPromptProfiles();
    const route = createToolRouting({ mode: "agent", mcpPresent: false, toolCalling: "native", useCompactSystemPrompt: () => false, promptProfiles: state });
    const first = route.selectToolDefs(true, false, "openai", "gpt-4o")!;
    const original = JSON.stringify(first);
    first[0]!.description = "caller mutation";
    first[0]!.parameters.properties["caller-mutation"] = { type: "string" };
    expect(JSON.stringify(route.selectToolDefs(true, false, "openai", "gpt-4o"))).toBe(original);
    const binding = state.bindings[0]!;
    const artifact = bindPromptProfile(state, binding.route, binding);
    expect(Object.isFrozen(artifact.tools[0]?.parameters)).toBe(true);
    expect(Reflect.set(binding.toolNames, 0, "made-up")).toBe(false);
  });

  it("rejects unknown/corrupt manifests, duplicate routes, extra authorization fields and changed artifact digests", () => {
    const state = createPromptProfiles();
    const routing = createToolRouting({ mode: "agent", mcpPresent: true, toolCalling: "native", useCompactSystemPrompt: () => false, promptProfiles: state });
    routing.buildStableSystemContent(true, "openai", "gpt-4o");
    for (const field of ["profileDigest", "promptDigest", "toolsDigest"] as const) {
      const corrupt = structuredClone(state);
      corrupt.bindings[0] = { ...corrupt.bindings[0]!, [field]: "0".repeat(64) };
      expect(() => validateProfileArtifacts(parsePromptProfiles(corrupt)!)).toThrow("No replacement profile");
    }
    const corruptRoute = structuredClone(state);
    corruptRoute.bindings[0] = { ...corruptRoute.bindings[0]!, route: "changed-route" };
    expect(() => validateProfileArtifacts(parsePromptProfiles(corruptRoute)!)).toThrow("No replacement profile");
    expect(() => validateProfileArtifacts(createPromptProfiles("unknown"))).toThrow("exact profile artifacts");
    expect(() => parsePromptProfiles({ ...state, version: 2 })).toThrow();
    expect(() => parsePromptProfiles({ ...state, allow: ["shell.exec"] })).toThrow();
    expect(() => parsePromptProfiles({ ...state, bindings: [state.bindings[0], state.bindings[0]] })).toThrow();
    expect(() => parsePromptProfiles(null)).toThrow();
    expect(parsePromptProfiles(undefined)).toBeUndefined();
  });
});
