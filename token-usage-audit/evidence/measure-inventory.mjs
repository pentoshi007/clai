import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] ?? process.cwd());
const load = (path) => import(pathToFileURL(resolve(root, path)).href);
const { createToolRouting } = await load("src/agent/turn/tool-routing.ts");
const { getToolDefinitions } = await load("src/tools/definitions.ts");
const { toOpenAiTools } = await load("src/llm/adapters/openai-tools.ts");
const { agentModeDirective } = await load("src/prompts/index.ts");
const { composeTurnMessages } = await load("src/agent/turn/setup/turn-messages.ts");
const estimate = (characters) => Math.ceil(characters / 3.3);
const hash = (value) => createHash("sha256").update(value).digest("hex");

function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "description")
    .map(([key, entry]) => [key, withoutDescriptions(entry)]));
}

const routes = [];
for (const [provider, model] of [["nvidia", "openai/gpt-oss-20b"], ["openai", "gpt-4o"]]) {
  for (const mcpPresent of [false, true]) {
    for (const compact of [false, true]) {
      const route = createToolRouting({ mode: "agent", mcpPresent, toolCalling: "native", useCompactSystemPrompt: () => compact });
      const system = route.buildStableSystemContent(true, provider, model);
      const definitions = route.selectToolDefs(true, compact, provider, model);
      const schema = JSON.stringify(toOpenAiTools(definitions));
      const mode = agentModeDirective({ executionRulesInSystem: system.includes("Professional execution method — applies to every domain") });
      const { messages } = composeTurnMessages({
        prompt: "Find and fix the failing subtotal test with fs.edit, preserving existing behavior.",
        displayPrompt: undefined, images: undefined, history: undefined,
        mode: "agent", systemSections: [mode, "REQUEST ENVIRONMENT\nOS: Linux; shell: /bin/sh; cwd: /project; plan: none"],
        selectedSkillNames: [], nativeToolsActive: true, inputTokenBudget: undefined,
        stableSystemContent: () => system, instructionsBlock: undefined,
        skillsBlock: undefined, plan: undefined, planApproved: false,
      });
      const freshCharacters = messages.reduce((sum, message) => sum + message.content.length, 0) + schema.length;
      routes.push({ provider, model, mcpPresent, compact, toolCount: definitions.length,
        systemCharacters: system.length, modeCharacters: mode.length, schemaCharacters: schema.length,
        freshCharacters, freshEstimatedTokens: estimate(freshCharacters),
        systemSha256: hash(system), wireSchemaSha256: hash(schema) });
    }
  }
}
const definitions = getToolDefinitions();
const tools = definitions.map((definition) => {
  const wire = toOpenAiTools([definition])[0];
  const serialized = JSON.stringify(wire);
  const structuralCharacters = JSON.stringify(withoutDescriptions(wire)).length;
  return { name: definition.name, wireCharacters: serialized.length,
    estimatedTokens: estimate(serialized.length), structuralCharacters,
    descriptionFieldCharacters: serialized.length - structuralCharacters };
}).sort((a, b) => b.wireCharacters - a.wireCharacters);
console.log(JSON.stringify({
  estimator: "ceil(JS string length / 3.3), not a tokenizer; excludes provider framing and real runtime additions",
  definitionCount: definitions.length,
  canonicalDefinitionsSha256: hash(JSON.stringify(definitions)),
  routes,
  tools,
}, null, 2));
