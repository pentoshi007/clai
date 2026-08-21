import { describe, expect, it } from "vitest";
import {
  anthropicSystemBlocks,
  buildAnthropicBody,
} from "../src/llm/anthropic.js";
import { parseAnthropicUsage } from "../src/llm/token-usage.js";
import { planContextMessage, PLAN_CONTEXT_PREFIX } from "../src/agent/plan-tool.js";
import { REQUEST_CONTEXT_PREFIX } from "../src/llm/system-messages.js";
import type { SessionPlan } from "../src/store/plan.js";
import type { ChatMessage, CompletionRequest } from "../src/types.js";

function plan(overrides: Partial<SessionPlan> = {}): SessionPlan {
  return {
    sessionId: "s1",
    goal: "ship the change",
    detail: "",
    tasks: [
      { id: "t1", title: "one", state: "done" },
      { id: "t2", title: "two", state: "in_progress" },
    ],
    status: "in_progress",
    kind: "coding",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as SessionPlan;
}

const CONSTITUTION = `SYSTEM CONSTITUTION\n${"stable rule line.\n".repeat(400)}`;

function request(messages: ChatMessage[]): CompletionRequest {
  return { model: "claude-sonnet-4-5", messages } as CompletionRequest;
}

describe("stable cache prefix and cache telemetry (CTX-007)", () => {
  it("keeps the system prefix byte-identical while mutable state advances", () => {
    const first = request([
      { role: "system", content: CONSTITUTION },
      { role: "system", content: planContextMessage(plan(), true) },
      { role: "user", content: "go" },
    ]);
    const advanced = plan({
      tasks: [
        { id: "t1", title: "one", state: "done" },
        { id: "t2", title: "two", state: "done" },
      ],
      updatedAt: "2026-02-02T00:00:00.000Z",
    } as Partial<SessionPlan>);
    const second = request([
      { role: "system", content: CONSTITUTION },
      { role: "system", content: planContextMessage(advanced, true) },
      { role: "user", content: "go" },
      { role: "assistant", content: "done" },
    ]);

    const systemOf = (req: CompletionRequest): string => {
      const body = JSON.parse(buildAnthropicBody(req, false)) as {
        system: Array<{ text: string }> | string;
      };
      return typeof body.system === "string" ? body.system : body.system[0]!.text;
    };

    expect(systemOf(first)).toBe(systemOf(second));
    expect(systemOf(first)).not.toContain(PLAN_CONTEXT_PREFIX);
  });

  it("keeps mutable request context authoritative after the cached system block", () => {
    const body = JSON.parse(
      buildAnthropicBody(
        request([
          { role: "system", content: CONSTITUTION },
          { role: "user", content: "prior history" },
          {
            role: "system",
            content: `${REQUEST_CONTEXT_PREFIX}\nOUTCOME CONTRACT\nGoal: current`,
          },
          { role: "user", content: "current" },
        ]),
        false,
      ),
    ) as {
      cache_control: { type: string };
      system: Array<Record<string, unknown>>;
      messages: Array<{ content: unknown }>;
    };

    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.system).toHaveLength(2);
    expect(body.system[0]).toMatchObject({
      text: CONSTITUTION,
      cache_control: { type: "ephemeral" },
    });
    expect(body.system[1]).toMatchObject({
      text: expect.stringContaining("OUTCOME CONTRACT"),
    });
    expect(JSON.stringify(body.messages)).not.toContain(REQUEST_CONTEXT_PREFIX);
  });

  it("marks the long system prefix as a cache breakpoint", () => {
    const blocks = anthropicSystemBlocks(CONSTITUTION);
    expect(Array.isArray(blocks)).toBe(true);
    expect((blocks as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
  });

  it("leaves a short system prompt as a plain string", () => {
    expect(anthropicSystemBlocks("short prompt")).toBe("short prompt");
    expect(anthropicSystemBlocks(undefined)).toBeUndefined();
  });

  it("reports cache reads and cache writes separately", () => {
    const usage = parseAnthropicUsage({
      input_tokens: 1_000,
      cache_read_input_tokens: 40_000,
      cache_creation_input_tokens: 2_000,
      output_tokens: 300,
    })!;
    expect(usage.promptTokens).toBe(43_000);
    expect(usage.cachedPromptTokens).toBe(40_000);
    expect(usage.cacheCreationTokens).toBe(2_000);
    expect(usage.completionTokens).toBe(300);
  });
});
