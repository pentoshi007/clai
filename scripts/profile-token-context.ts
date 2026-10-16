import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { ChatMessage } from "../src/types.js";
import type { SessionPlan } from "../src/store/plan.js";
import { upsertKeyed } from "../src/agent/injected-blocks.js";
import { upsertSessionStateMessage } from "../src/agent/session-state.js";
import { planContextMessage, upsertPlanContextMessage } from "../src/agent/plan-tool.js";
import { dropSectionsAlreadyInHistory } from "../src/agent/turn/setup/turn-messages.js";
import { createToolRouting } from "../src/agent/turn/tool-routing.js";
import type { AgentPromptSection } from "../src/agent/prompt-composer.js";

function benchmark(action: () => void, samples: number) {
  for (let index = 0; index < 20; index += 1) action();
  const timings: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    action();
    timings.push(performance.now() - started);
  }
  timings.sort((left, right) => left - right);
  return { samples, p50Ms: timings[Math.floor(samples * 0.5)]!, p95Ms: timings[Math.floor(samples * 0.95)]!, totalMs: timings.reduce((sum, value) => sum + value, 0) };
}

export function profileTokenContext(samples = 1000) {
  if (!Number.isInteger(samples) || samples < 20 || samples > 10000) throw new Error("Samples must be an integer in [20, 10000]");
  const plan: SessionPlan = { sessionId: "context-profile", goal: "Verify all phases", detail: "Keep every acceptance criterion and dependency", kind: "coding", status: "approved", createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z",
    tasks: Array.from({ length: 60 }, (_, index) => ({ id: `t${index + 1}`, title: `Verify phase ${index + 1}`, state: "pending", dependencies: index ? [`t${index}`] : [], resourceLocks: [], acceptanceCriteria: `Preserve phase ${index + 1} authority, verify positive/negative behavior and retain independent evidence` })) };
  const planBlock = planContextMessage(plan, true);
  const messages: ChatMessage[] = [{ role: "system", content: "Stable core" }];
  const apply = (): void => {
    upsertKeyed(messages, "PROJECT INSTRUCTIONS", "PROJECT INSTRUCTIONS\nRetain scope, acceptance and verification");
    upsertSessionStateMessage(messages, "goal: verify every criterion");
    upsertPlanContextMessage(messages, planBlock);
  };
  apply();
  const initialBytes = Buffer.byteLength(JSON.stringify(messages));
  const initialCount = messages.length;
  const sent = structuredClone(messages);
  const upserts = benchmark(apply, samples);
  const repeated = { addedMessages: messages.length - initialCount, addedBytes: Buffer.byteLength(JSON.stringify(messages)) - initialBytes };
  upsertKeyed(messages, "PROJECT INSTRUCTIONS", "PROJECT INSTRUCTIONS\nChanged scope is authoritative");
  upsertKeyed(messages, "PROJECT INSTRUCTIONS", undefined);
  upsertKeyed(messages, "PROJECT INSTRUCTIONS", "PROJECT INSTRUCTIONS\nRetain scope, acceptance and verification");
  const transitions = { appendedMessages: messages.length - initialCount, sentHistoryPreserved: JSON.stringify(messages.slice(0, initialCount)) === JSON.stringify(sent) };
  const sections: AgentPromptSection[] = [
    { kind: "context", content: "Project context from .clai/context.md:\nComplete authoritative project rules" },
    { kind: "context", content: "MCP TOOL CONTEXT\nSelection off; permissions enforced" },
    { kind: "context", content: "ORCHESTRATION: OFF" },
    { kind: "outcome", content: "Current task: verify behavior" },
  ];
  const history: ChatMessage[] = [{ role: "system", content: sections.map((section) => section.content).join("\n\n") }];
  const kept = dropSectionsAlreadyInHistory(sections, history, "next turn");
  const sectionFiltering = benchmark(() => { dropSectionsAlreadyInHistory(sections, history, "next turn"); }, samples);
  const routing = createToolRouting({ mode: "agent", mcpPresent: true, toolCalling: "native", useCompactSystemPrompt: () => false });
  const prompt = routing.buildStableSystemContent(true, "openai", "gpt-4o");
  const tools = routing.selectToolDefs(true, false, "openai", "gpt-4o");
  const promptRendering = benchmark(() => { routing.buildStableSystemContent(true, "openai", "gpt-4o"); }, samples);
  const toolSelection = benchmark(() => { routing.selectToolDefs(true, false, "openai", "gpt-4o"); }, samples);
  const planRendering = benchmark(() => { planContextMessage(plan, true); }, samples);
  return { version: 1, decision: "retain-baseline", incrementalStartupTokenSavings: 0, incrementalTaskTokenSavings: 0,
    repeated, transitions, sectionFiltering: { ...sectionFiltering, supplied: sections.length, retained: kept.map((section) => section.content.split("\n")[0]) },
    upserts, promptRendering, toolSelection, planRendering, planTasks: plan.tasks.length, planBytes: Buffer.byteLength(planBlock),
    promptBytes: Buffer.byteLength(prompt), toolCount: tools?.length ?? 0,
    toolsSha256: createHash("sha256").update(JSON.stringify(tools)).digest("hex"),
    node: process.version, platform: process.platform, architecture: process.arch,
  };
}
