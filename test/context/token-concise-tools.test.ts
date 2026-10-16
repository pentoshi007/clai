import { describe, expect, it } from "vitest";
import { getToolDefinitions } from "../../src/tools/definitions.js";
import { conciseToolDefinitions, CONCISE_DESCRIPTIONS } from "../../src/tools/definitions/candidate-descriptions.js";
import { legacyPromptProfile, profileDigest } from "../../src/prompts/legacy-profile.js";
import { conciseToolsProfile } from "../../src/prompts/concise-tools-profile.js";
import { toOpenAiTools } from "../../src/llm/adapters/openai-tools.js";
import { toAnthropicTools } from "../../src/llm/adapters/anthropic-tools.js";
import { toGeminiFunctionDeclarations } from "../../src/llm/adapters/gemini-tools.js";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";
import { geminiBody } from "../../src/llm/gemini.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import { finalizeCodexBody } from "../../src/llm/codex-request.js";
import { META_STREAM_TERMINAL } from "../../src/llm/stream-terminal.js";
import { validateArgs } from "../../src/tools/web/validate-args.js";
import { MIN_MAX_BYTES, MAX_MAX_BYTES, DEFAULT_MAX_BYTES } from "../../src/tools/web/types.js";
import { createPromptProfiles, parsePromptProfiles } from "../../src/prompts/profile-state.js";
import { createToolRouting } from "../../src/agent/turn/tool-routing.js";
import { validateProfileArtifacts } from "../../src/prompts/profile-binding.js";

function contract(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry: unknown) => contract(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "description").map(([key, entry]) => [key, contract(entry)]));
}

const legacy = getToolDefinitions();
const candidate = conciseToolDefinitions(legacy);
const names = legacy.map((definition) => definition.name);

describe("concise description candidate contract", () => {
  it("preserves all 47 ordered contracts/flags except the explicit runtime-aligned web bound", () => {
    expect(profileDigest(JSON.stringify(legacy))).toBe("02631147c616726c7fb421b355e359a09828eb56190036e282073db641b3c6c7");
    expect(candidate).toHaveLength(47);
    expect(candidate.map((definition) => definition.name)).toEqual(names);
    for (const definition of candidate) {
      const baseline = structuredClone(legacy.find((entry) => entry.name === definition.name)!);
      if (definition.name === "web.fetch") baseline.parameters.properties.maxBytes = { type: "integer", minimum: MIN_MAX_BYTES, maximum: MAX_MAX_BYTES };
      expect(contract(definition)).toEqual(contract(baseline));
    }
    expect(JSON.stringify(candidate)).not.toContain('"$ref"');
    expect(candidate.some((definition) => definition.name === "http.fetch")).toBe(true);
    expect(JSON.stringify(toOpenAiTools(candidate)).length).toBeLessThan(JSON.stringify(toOpenAiTools(legacy)).length);
    const mutated = structuredClone(candidate);
    mutated[0]!.parameters.required = ["invented"];
    expect(contract(mutated)).not.toEqual(contract(candidate));
    expect(contract([...candidate].reverse())).not.toEqual(contract(candidate));
  });

  it("preserves the shortened descriptions' disambiguating obligations", () => {
    const fragments: Readonly<Record<string, readonly string[]>> = {
      "fs.read": ["1–10", "exactly one", "each files entry requires path", "never top-level filters", "No filler files", "hasMore=true", "never repeat path-only", "1-indexed inclusive", "successful reads survive", "failed/unfinished"],
      "http.fetch": ["Raw-by-default", "redirect response headers", "headers/cookies", "decoded source body", "SHA-256", "model-context cap are separate", "credentials stripped", "no status retries", "5xx/429", "verification off", "web.fetch includeTls"],
      "shell.exec": ["foreground", "never heuristic", "milliseconds", "60000", "shell.wait", "readiness probe", "shell.stop", "finite work", "no polling", "job.read", "overrides responder", "authorization expiry", "cwd instead of cd"],
      "subagent.start": ["read-only", "ORCHESTRATION: ON", "Never delegate a single", ">=2 unrelated", "2–3 calls", "non-goals", "not a fixed procedure/gate", "do not inspect delegated", "never whole conversation", "sibling assignments together", "cannot modify/delete files or delegate"],
    };
    for (const [name, expected] of Object.entries(fragments)) for (const fragment of expected) expect(CONCISE_DESCRIPTIONS[name]).toContain(fragment);
    const plan = candidate.find((definition) => definition.name === "plan.create")!;
    expect(plan.parameters.required).toEqual(["goal", "tasks", "kind"]);
    expect(JSON.stringify(plan.parameters.properties.kind)).toContain('Use \\"general\\" only');
  });

  it.each([MIN_MAX_BYTES - 1, MIN_MAX_BYTES, MAX_MAX_BYTES, MAX_MAX_BYTES + 1, 1024.5])("aligns emitted web.fetch bounds with runtime for %s bytes", (maxBytes) => {
    const bound = candidate.find((definition) => definition.name === "web.fetch")!.parameters.properties.maxBytes;
    expect(bound).toMatchObject({ type: "integer", minimum: 1024, maximum: 1048576 });
    const accepted = Number.isInteger(maxBytes) && maxBytes >= MIN_MAX_BYTES && maxBytes <= MAX_MAX_BYTES;
    expect(validateArgs({ url: "https://example.test", maxBytes }).ok).toBe(accepted);
    const normal = validateArgs({ url: "https://example.test" });
    expect(normal).toMatchObject({ ok: true, value: { maxBytes: DEFAULT_MAX_BYTES } });
    expect(getToolDefinitions().find((definition) => definition.name === "web.fetch")!.parameters.properties.maxBytes).not.toHaveProperty("minimum");
  });

  it("preserves ordered schemas in every final provider wrapper, including Responses and Codex namespaces", () => {
    expect(toOpenAiTools(candidate).map((tool) => tool.function.parameters)).toEqual(candidate.map((definition) => definition.parameters));
    expect(toAnthropicTools(candidate).map((tool) => tool.input_schema)).toEqual(candidate.map((definition) => definition.parameters));
    const gemini = toGeminiFunctionDeclarations(candidate);
    expect(gemini.map((tool) => tool.name)).toEqual(candidate.map((definition) => definition.wireName));
    for (const tool of gemini) {
      expect(tool.parameters.properties).toBeDefined();
      expect(JSON.stringify(tool)).not.toContain("oneOf");
    }
    expect(gemini.find((tool) => tool.name === "web_fetch")?.parameters).toMatchObject({ properties: { maxBytes: { minimum: MIN_MAX_BYTES, maximum: MAX_MAX_BYTES } } });
    const messages = [{ role: "system" as const, content: "synthetic stable core" }, { role: "user" as const, content: "synthetic task" }];
    const responses: unknown = JSON.parse(buildResponsesBody({ baseUrl: "https://gateway.test/v1", providerId: "openai", displayName: "Synthetic", artifactDialect: "openai-compatible", terminalPolicy: META_STREAM_TERMINAL,
      buildHeaders: () => ({}), reasoningPayload: () => undefined, bodyExtras: () => ({}) }, { model: "gpt-4o", messages, stream: false, tools: candidate }));
    const tools = candidate.map((definition) => ({ type: "function", name: definition.wireName, description: definition.description, parameters: definition.parameters }));
    expect(responses).toMatchObject({ tools });
    expect(finalizeCodexBody({ model: "gpt-5.6-luna", input: [], tools, prompt_cache_key: "synthetic-affinity" }, true)).toMatchObject({ input: [{ tools: [{ type: "namespace", name: "functions", tools }] }] });
    expect(JSON.parse(buildAnthropicBody({ model: "claude-sonnet-4-5", messages, tools: candidate }, false))).toMatchObject({ tools: toAnthropicTools(candidate) });
    expect(JSON.parse(geminiBody({ model: "gemini-2.5-flash", messages, tools: candidate }))).toMatchObject({ tools: [{ functionDeclarations: gemini }] });
  });

  it.each(["concise-tools-v1", "density-tools-v1"] as const)("pins %s across restore and isolates caller mutations", (id) => {
    const profile = conciseToolsProfile(id);
    expect(profile.tools(names)).toEqual(candidate);
    expect(profile.digest).not.toBe(legacyPromptProfile().digest);
    const first = profile.tools(names);
    first[0]!.description = "caller changed";
    expect(profile.tools(names)).toEqual(candidate);
    const state = createPromptProfiles(id);
    const route = createToolRouting({ mode: "agent", mcpPresent: true, toolCalling: "native", useCompactSystemPrompt: () => false, promptProfiles: state });
    const prompt = route.buildStableSystemContent(true, "openai", "gpt-4o");
    const tools = route.selectToolDefs(true, false, "openai", "gpt-4o");
    const restored = parsePromptProfiles(JSON.parse(JSON.stringify(state)))!;
    validateProfileArtifacts(restored);
    const continued = createToolRouting({ mode: "agent", mcpPresent: false, toolCalling: "native", useCompactSystemPrompt: () => true, promptProfiles: restored });
    expect(continued.buildStableSystemContent(true, "openai", "gpt-4o")).toBe(prompt);
    expect(continued.selectToolDefs(true, true, "openai", "gpt-4o")).toEqual(tools);
  });
});
