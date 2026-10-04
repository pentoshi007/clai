import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ChatMessage } from "../src/types.js";

const baseline = process.argv[2];
if (!baseline) throw new Error("Usage: node --import tsx scripts/measure-token-overhead.ts <baseline-checkout>");

const estimate = (characters: number): number => Math.ceil(characters / 3.3);
const sha256 = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");

async function measure(checkout: string, native: boolean, compact: boolean, prompt: string) {
  const source = join(resolve(checkout), "src");
  const [routing, prompts, assembly, adapter, history] = await Promise.all([
    import(pathToFileURL(join(source, "agent/turn/tool-routing.ts")).href) as Promise<typeof import("../src/agent/turn/tool-routing.js")>,
    import(pathToFileURL(join(source, "prompts/index.ts")).href) as Promise<typeof import("../src/prompts/index.js")>,
    import(pathToFileURL(join(source, "agent/turn/setup/turn-messages.ts")).href) as Promise<typeof import("../src/agent/turn/setup/turn-messages.js")>,
    import(pathToFileURL(join(source, "llm/adapters/openai-tools.ts")).href) as Promise<typeof import("../src/llm/adapters/openai-tools.js")>,
    import(pathToFileURL(join(source, "agent/tool-call-parser.ts")).href) as Promise<typeof import("../src/agent/tool-call-parser.js")>,
  ]);
  const route = routing.createToolRouting({
    mode: "agent", mcpPresent: false,
    toolCalling: native ? "native" : "text", useCompactSystemPrompt: () => compact,
  });
  const system = route.buildStableSystemContent(native, "nvidia", "openai/gpt-oss-20b");
  const tools = route.selectToolDefs(native, compact, "nvidia", "openai/gpt-oss-20b");
  const schema = tools ? JSON.stringify(adapter.toOpenAiTools(tools)) : "";
  const mode = prompts.agentModeDirective({
    executionRulesInSystem: system.includes("Professional execution method — applies to every domain"),
  });
  const compose = (task: string, prior?: ChatMessage[]) => assembly.composeTurnMessages({
    prompt: task, displayPrompt: undefined, images: undefined, history: prior,
    mode: "agent", systemSections: [mode, "REQUEST ENVIRONMENT\nOS: Linux; shell: /bin/sh; cwd: /project; plan: none"],
    selectedSkillNames: [], nativeToolsActive: native, inputTokenBudget: undefined,
    stableSystemContent: () => system, instructionsBlock: undefined, skillsBlock: undefined,
    plan: undefined, planApproved: false,
  });
  const fresh = compose(prompt);
  const continuation = compose("Continue: verify the boundary cases without repeating completed edits.",
    history.buildTurnHistory(fresh.messages, "The edit and its verification completed."));
  const contentLength = (messages: ChatMessage[]) => messages.reduce((total, message) => total + message.content.length, 0);
  const freshCharacters = contentLength(fresh.messages) + schema.length;
  const continuedCharacters = contentLength(continuation.messages) + schema.length;
  return {
    systemCharacters: system.length,
    modeCharacters: mode.length,
    schemaCharacters: schema.length,
    toolCount: tools?.length ?? route.routeToolNames("nvidia", "openai/gpt-oss-20b").length,
    toolSchemaSha256: sha256(tools),
    userTaskCopies: JSON.stringify(fresh.messages).split(JSON.stringify(prompt).slice(1, -1)).length - 1,
    freshCharacters,
    freshEstimatedTokens: estimate(freshCharacters),
    continuedCharacters,
    continuedEstimatedTokens: estimate(continuedCharacters),
  };
}

const short = "Find and fix the failing subtotal test with fs.edit, preserving existing behavior.";
const long = `${short}\n${"Preserve quantity, empty-cart and currency-rounding invariants with independent regression evidence. ".repeat(50)}`;
const scenarios = [
  { name: "native-default-short", native: true, compact: false, prompt: short },
  { name: "native-default-long", native: true, compact: false, prompt: long },
  { name: "native-compact", native: true, compact: true, prompt: short },
  { name: "text-default", native: false, compact: false, prompt: short },
  { name: "text-compact", native: false, compact: true, prompt: short },
];
const results = [];
for (const scenario of scenarios) {
  const before = await measure(baseline, scenario.native, scenario.compact, scenario.prompt);
  const after = await measure(process.cwd(), scenario.native, scenario.compact, scenario.prompt);
  results.push({
    scenario: scenario.name, before, after,
    freshCharactersSaved: before.freshCharacters - after.freshCharacters,
    freshEstimatedTokensSaved: before.freshEstimatedTokens - after.freshEstimatedTokens,
    freshReductionPercent: Number((100 * (1 - after.freshCharacters / before.freshCharacters)).toFixed(2)),
  });
}
console.log(JSON.stringify({
  estimator: "ceil(content and schema characters / 3.3); excludes provider framing; no model calls",
  results,
}, null, 2));
