/**
 * Request-assembly contract tests (audit S4).
 * Guards mandatory prompt sections, stable ordering, and cache-friendly datetime.
 */
import { describe, expect, it } from "vitest";
import {
  composeAgentSystemPrompt,
  type AgentPromptSection,
} from "../src/agent/prompt-composer.js";
import {
  currentDateTimeContext,
  floorToLocalHour,
  renderAgentSystemPrompt,
  renderCompactAgentSystemPrompt,
  renderRequestEnvironmentContext,
} from "../src/prompts/index.js";
import { hasOrphanToolMessages } from "../src/agent/tool-history.js";
import type { ChatMessage } from "../src/types.js";

describe("prompt assembly contract", () => {
  const mandatory: AgentPromptSection[] = [
    {
      kind: "constitution",
      content: "CONSTITUTION_SENTINEL\n# ROLE\nYou are clai.",
      mandatory: true,
    },
    {
      kind: "outcome",
      content: "OUTCOME CONTRACT\nGoal: test",
      mandatory: true,
    },
    {
      kind: "plan",
      content: "ACTIVE PLAN\nNo persisted plan is active for this turn.",
      mandatory: true,
    },
    {
      kind: "scope",
      content: "ENGAGEMENT SCOPE\nNo active remote-security scope applies.",
      mandatory: true,
    },
    {
      kind: "context",
      content: "TASK STATE\nMode: agent. Current request: ship it",
      mandatory: true,
    },
  ];

  it("always includes mandatory mode/outcome/plan/scope/constitution", () => {
    const composed = composeAgentSystemPrompt({
      mode: "agent",
      nativeToolsActive: true,
      sections: mandatory,
    });
    for (const kind of [
      "mode",
      "outcome",
      "plan",
      "scope",
      "constitution",
      "context",
    ] as const) {
      expect(composed.included).toContain(kind);
    }
    expect(composed.content).toContain("CURRENT MODE: AGENT");
    expect(composed.content).toContain("OUTCOME CONTRACT");
    expect(composed.content).toContain("ACTIVE PLAN");
    expect(composed.content).toContain("ENGAGEMENT SCOPE");
    expect(composed.content).toContain("CONSTITUTION_SENTINEL");
  });

  it("orders the stable constitution before dynamic request sections", () => {
    const composed = composeAgentSystemPrompt({
      mode: "agent",
      nativeToolsActive: false,
      sections: [...mandatory].reverse(),
    });
    const constitutionAt = composed.content.indexOf("CONSTITUTION_SENTINEL");
    const modeAt = composed.content.indexOf("CURRENT MODE:");
    const planAt = composed.content.indexOf("ACTIVE PLAN");
    const scopeAt = composed.content.indexOf("ENGAGEMENT SCOPE");
    const outcomeAt = composed.content.indexOf("OUTCOME CONTRACT");
    expect(constitutionAt).toBe(0);
    expect(constitutionAt).toBeLessThan(modeAt);
    expect(modeAt).toBeLessThan(planAt);
    expect(planAt).toBeLessThan(scopeAt);
    expect(scopeAt).toBeLessThan(outcomeAt);
  });

  it("never drops mandatory sections under a tight maxTokens budget", () => {
    const composed = composeAgentSystemPrompt({
      mode: "plan",
      nativeToolsActive: true,
      maxTokens: 8,
      sections: [
        ...mandatory,
        {
          kind: "focus",
          content: "FOCUS CARD\n" + "x".repeat(5000),
          mandatory: false,
        },
      ],
    });
    expect(composed.included).toContain("mode");
    expect(composed.included).toContain("outcome");
    expect(composed.included).toContain("plan");
    expect(composed.included).toContain("scope");
    expect(composed.included).toContain("constitution");
    expect(composed.omitted).toContain("focus");
  });

  it("agent system prompt has no unresolved templates", () => {
    const p = renderAgentSystemPrompt("shell.exec, fs.read");
    expect(p).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(p).toMatch(/ISO hour:/);
  });

  it("compact agent prompt remains small, template-free, and methodologically complete", () => {
    const p = renderCompactAgentSystemPrompt("shell.exec");
    expect(p.length).toBeLessThan(8_000);
    expect(p).not.toMatch(/\{\{[a-z_]+\}\}/);
    expect(p).toContain("model the relevant system/contracts/surfaces");
    expect(p).toContain("tested/untested status");
    expect(p).toContain("not a canned sequence");
    expect(p).toContain("reconcile every material criterion");
  });

  it("keeps mutable environment facts outside the stable constitution", () => {
    const stable = renderAgentSystemPrompt("shell.exec, fs.read", {
      nativeTools: true,
      stableEnvironment: true,
    });
    expect(stable).toContain("see REQUEST ENVIRONMENT");
    expect(stable).not.toContain("ISO hour:");
    expect(renderRequestEnvironmentContext()).toContain("ISO hour:");
    expect(renderRequestEnvironmentContext()).toContain("Working directory:");
  });

  it("datetime floor is hour-stable across minutes", () => {
    const a = floorToLocalHour(new Date("2026-07-18T10:05:00"));
    const b = floorToLocalHour(new Date("2026-07-18T10:55:00"));
    expect(a.getTime()).toBe(b.getTime());
    expect(currentDateTimeContext(new Date("2026-07-18T10:05:00"))).toBe(
      currentDateTimeContext(new Date("2026-07-18T10:55:00")),
    );
  });

  it("rejects orphan tool messages in assembled history", () => {
    const bad: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "tool",
        content: "orphan",
        toolCallId: "missing",
      },
    ];
    expect(hasOrphanToolMessages(bad)).toBe(true);

    const good: ChatMessage[] = [
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "fs.read", arguments: {} }],
      },
      { role: "tool", content: "ok", toolCallId: "c1", name: "fs.read" },
    ];
    expect(hasOrphanToolMessages(good)).toBe(false);
  });
});
