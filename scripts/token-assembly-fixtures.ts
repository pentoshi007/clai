import { createHash } from "node:crypto";
import type { ChatMessage, Mode, ProviderId } from "../src/types.js";
import type { SessionPlan } from "../src/store/plan.js";
import { createToolRouting } from "../src/agent/turn/tool-routing.js";
import { classifyTurnPrompt } from "../src/agent/turn/setup/prompt-classification.js";
import { buildSystemSections } from "../src/agent/turn/system-sections.js";
import { composeTurnMessages } from "../src/agent/turn/setup/turn-messages.js";
import { buildSessionStateRefresher } from "../src/agent/turn/setup/session-state.js";
import { createTurnEvidenceFlags } from "../src/agent/turn/evidence-flags.js";
import { orchestrationContext } from "../src/agent/subagents/tools.js";
import { accountAssembledRequest, estimateTextTokens } from "../src/agent/request-accounting.js";
import { chatCompletionsBodyFromPlan } from "../src/llm/wire/chat-body.js";
import { toOpenAiTools } from "../src/llm/adapters/openai-tools.js";

export type AssemblyFixtureKind = "coding" | "security" | "ask" | "plan";
export interface AssemblyFixture {
  readonly id: string;
  readonly kind: AssemblyFixtureKind;
  readonly native: boolean;
  readonly compact: boolean;
  readonly mcp: boolean;
  readonly vision: boolean;
}

const kinds: readonly AssemblyFixtureKind[] = ["coding", "security", "ask", "plan"];
const booleans = [false, true] as const;
export const assemblyFixtureMatrix: readonly AssemblyFixture[] = kinds.flatMap((kind) =>
  booleans.flatMap((native) => booleans.flatMap((compact) => booleans.flatMap((mcp) =>
    booleans.map((vision) => ({
      id: [kind, native ? "native" : "text", compact ? "compact" : "full", mcp ? "mcp" : "local", vision ? "vision" : "textual"].join("-"),
      kind, native, compact, mcp, vision,
    })),
  ))),
);

const prompts: Readonly<Record<AssemblyFixtureKind, string>> = {
  coding: "Fix the failing subtotal calculation in the existing project; preserve empty and fractional carts and verify the regression.",
  security: "Perform a pentest of the synthetic lab at http://127.0.0.1 for the known authorization issue, preserve raw evidence, and distinguish the patched endpoint.",
  ask: "Explain whether the existing subtotal calculation correctly handles empty and fractional carts. Do not change anything.",
  plan: "Plan the complete webhook validation implementation, including invalid signatures, replay boundaries and independent regression proof. Do not implement yet.",
};
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const reasoning = "Check the synthetic baseline before editing.";
const skill = {
  name: "synthetic-review", description: "Review synthetic coding and security fixtures with independent evidence.",
  dir: "/project/.skills/synthetic-review", file: "/project/.skills/synthetic-review/SKILL.md",
  scope: "project" as const, tool: "clai", root: "/project/.skills",
};
const instructionsBlock = "PROJECT INSTRUCTIONS\nPreserve synthetic project constraints in full. Do not add comments or dependencies.";
const skillsBlock = "ACTIVE SKILLS\nsynthetic-review\nCheck both the positive outcome and its negative control; retain complete evidence.";

function fixturePlan(): SessionPlan {
  return {
    schemaVersion: 2, version: 1, sessionId: "assembly-fixture", kind: "coding", goal: "Validate webhook contracts",
    detail: "Implement the complete validation roadmap; retain every acceptance criterion on continuation.",
    status: "approved", createdAt: "2026-10-16T09:00:00.000Z", updatedAt: "2026-10-16T09:00:00.000Z",
    tasks: [{ id: "t1", title: "Validate signatures", state: "pending", dependencies: [], resourceLocks: [],
      acceptanceCriteria: "Verify invalid signatures and replay boundaries without dropping criteria" }],
  };
}

export async function assembleTokenFixture(fixture: AssemblyFixture) {
  const mode: Mode = fixture.kind === "ask" ? "ask" : fixture.kind === "plan" ? "plan" : "agent";
  const provider: ProviderId = fixture.vision ? "openai" : "nvidia";
  const model = fixture.vision ? "gpt-4o" : "openai/gpt-oss-20b";
  const routing = createToolRouting({ mode, mcpPresent: fixture.mcp, toolCalling: fixture.native ? "native" : "text", useCompactSystemPrompt: () => fixture.compact });
  const stablePrompt = routing.buildStableSystemContent(fixture.native, provider, model);
  const tools = routing.selectToolDefs(fixture.native, fixture.compact, provider, model);
  const prompt = prompts[fixture.kind];
  const plan = fixture.kind === "plan" ? fixturePlan() : undefined;
  const history: ChatMessage[] = [
    { role: "user", content: "Retain the synthetic acceptance criteria for the next turn." },
    { role: "assistant", content: "The synthetic baseline is recorded.", reasoningArtifacts: [{
      version: 1, kind: "plaintext", raw: reasoning,
      provenance: { provider, dialect: "openai-compatible" }, replay: { scope: "all-history", persistence: "all-turns" },
      position: { sequence: 0, placement: "assistant" }, accounting: { byteLength: Buffer.byteLength(reasoning), estimatedTokens: estimateTextTokens(reasoning) },
    }] },
  ];
  const classification = classifyTurnPrompt(prompt, history);
  const { sections, pentestSession } = await buildSystemSections({
    ...classification, prompt, mode, plan, history, previousTurn: undefined,
    sessionId: "assembly-fixture", projectContext: "Synthetic existing project with fixed coding and security acceptance criteria.",
    destinationHint: undefined, isPlanMode: mode === "plan",
    executionRulesInSystem: stablePrompt.includes("Professional execution method — applies to every domain"),
    skillsAvailable: true, skillIndex: { skills: [skill], truncated: false }, selectedSkillNames: [skill.name],
    inputTokenBudget: undefined,
    getMcpContext: () => fixture.mcp ? "MCP TOOL CONTEXT\nSynthetic server fixture: connected, selection off; discover before calling." : undefined,
    getProjectRoot: () => "/project", getRunningJobs: () => [], getRecentJobs: () => [],
  });
  sections.push(orchestrationContext(false));
  const { messages, requestContextMessage } = composeTurnMessages({
    prompt, displayPrompt: undefined, images: fixture.vision ? [{ mediaType: "image/png", dataBase64: tinyPng, path: "/project/tiny.png" }] : undefined,
    history, mode, systemSections: sections, selectedSkillNames: [skill.name], nativeToolsActive: fixture.native,
    inputTokenBudget: undefined, stableSystemContent: () => stablePrompt, instructionsBlock, skillsBlock, plan, planApproved: Boolean(plan),
  });
  buildSessionStateRefresher({
    messages, prompt, requestContextMessage, refreshInjectedBlocks: () => {},
    suppressed: classification.idleOrSocialPrompt || classification.informationalQuery,
    requiresState: classification.buildLikeTurn || classification.pentestLikeTurn,
    featureAppAsk: false, pentestSession, evidenceFlags: createTurnEvidenceFlags(),
    activePlan: () => plan, planApproved: () => Boolean(plan), runningJobs: () => [], projectRoot: () => "/project",
  })(plan);
  return { messages, tools, prompt, history, stablePrompt, provider, model, toolNames: routing.routeToolNames(provider, model) };
}

export function measureText(value: string) {
  return { characters: value.length, bytes: Buffer.byteLength(value), estimatedTokens: estimateTextTokens(value), sha256: createHash("sha256").update(value).digest("hex") };
}

export function measureTokenAssembly(fixture: AssemblyFixture, assembled: Awaited<ReturnType<typeof assembleTokenFixture>>) {
  const { messages, tools, history, provider, model, stablePrompt, prompt } = assembled;
  const { plan, accounting } = accountAssembledRequest({ provider, model, messages, tools, stream: false });
  const wire = chatCompletionsBodyFromPlan(plan);
  const content = messages.map((message) => message.content).join("");
  const dynamicContext = messages.slice(1 + history.length).filter((message) => message.role === "system").map((message) => message.content).join("");
  return {
    ...fixture, provider, model, precision: "character-estimate" as const, providerUsage: null,
    toolCount: tools?.length ?? 0, textToolNameCount: fixture.native ? 0 : assembled.toolNames.length,
    userTaskCopies: messages.filter((message) => message.role === "user" && message.content === prompt).length,
    messageCount: messages.length,
    components: {
      stablePrompt: measureText(stablePrompt), history: measureText(history.map((message) => message.content).join("")),
      currentTask: measureText(prompt), dynamicContext: measureText(dynamicContext), messageContent: measureText(content),
      canonicalTools: measureText(JSON.stringify(tools ?? [])), wireTools: measureText(JSON.stringify(tools ? toOpenAiTools(tools) : [])),
    },
    canonicalMessages: measureText(JSON.stringify(messages)), finalWire: measureText(wire),
    accounting: { rawRequestTokens: accounting.rawRequestTokens, instructionsTokens: accounting.instructionsTokens,
      historyTokens: accounting.historyTokens, liveTokens: accounting.liveTokens, toolsTokens: accounting.toolsTokens,
      imageTokens: accounting.imageTokens, imageCount: accounting.imageCount, artifactTokens: accounting.artifactTokens,
      replayedArtifactCount: accounting.replayedArtifactCount },
  };
}
