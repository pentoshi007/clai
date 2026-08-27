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
      system: Array<Record<string, unknown>>;
      messages: Array<{ role: string; content: unknown }>;
    };

    expect(body).not.toHaveProperty("cache_control");
    expect(body.system).toHaveLength(2);
    expect(body.system[0]).toMatchObject({
      text: CONSTITUTION,
      cache_control: { type: "ephemeral" },
    });
    expect(body.system[1]).toMatchObject({
      text: expect.stringContaining("OUTCOME CONTRACT"),
    });
    expect(JSON.stringify(body.messages)).not.toContain(REQUEST_CONTEXT_PREFIX);
    expect(body.messages.at(-1)).toEqual({
      role: "user",
      content: [
        {
          type: "text",
          text: "current",
          cache_control: { type: "ephemeral" },
        },
      ],
    });
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

describe("Anthropic explicit conversation cache breakpoints", () => {
  it("marks the last stable message before mutable system and internal tails", () => {
    const body = JSON.parse(
      buildAnthropicBody(
        request([
          { role: "system", content: CONSTITUTION },
          { role: "user", content: "prior request" },
          { role: "assistant", content: "stable answer" },
          { role: "system", content: "ACTIVE PLAN v2\nmutable" },
          {
            role: "system",
            content: "SESSION STATE / WORKING MEMORY\nmutable",
          },
          { role: "user", content: "retry guidance", internal: true },
        ]),
        false,
      ),
    ) as {
      system: Array<Record<string, unknown>>;
      messages: Array<{ role: string; content: unknown }>;
    };

    const marked = body.messages.filter((message) =>
      JSON.stringify(message).includes('"cache_control"'),
    );
    expect(marked).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "stable answer",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    expect(JSON.stringify(body.messages.slice(-3))).not.toContain(
      '"cache_control"',
    );
    const allMarkers = JSON.stringify({
      system: body.system,
      messages: body.messages,
    }).match(/"cache_control"/g);
    expect(allMarkers).toHaveLength(2);
  });

  it("keeps tool-use and tool-result blocks separate while marking the final result", () => {
    const body = JSON.parse(
      buildAnthropicBody(
        request([
          { role: "system", content: CONSTITUTION },
          { role: "user", content: "inspect both files" },
          {
            role: "assistant",
            content: "checking",
            toolCalls: [
              { id: "tool-1", name: "fs.read", args: { path: "a.ts" } },
              { id: "tool-2", name: "fs.read", args: { path: "b.ts" } },
            ],
          },
          {
            role: "tool",
            toolCallId: "tool-1",
            content: "a contents",
            ok: true,
          },
          {
            role: "tool",
            toolCallId: "tool-2",
            content: "b contents",
            ok: true,
          },
          { role: "system", content: "ACTIVE PLAN v3\nmutable" },
        ]),
        false,
      ),
    ) as {
      messages: Array<{
        role: string;
        content: string | Array<Record<string, unknown>>;
      }>;
    };

    const assistant = body.messages.find((message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_use"),
    );
    const results = body.messages.find((message) =>
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_result"),
    );
    expect((assistant?.content as Array<Record<string, unknown>>).map((block) => block.type)).toEqual([
      "text",
      "tool_use",
      "tool_use",
    ]);
    expect(assistant).not.toHaveProperty(
      "content.2.cache_control",
    );
    expect((results?.content as Array<Record<string, unknown>>).map((block) => block.type)).toEqual([
      "tool_result",
      "tool_result",
    ]);
    expect(results).toHaveProperty(
      "content.1.cache_control",
      { type: "ephemeral" },
    );
    expect(results).toHaveProperty("content.0.tool_use_id", "tool-1");
    expect(results).toHaveProperty("content.1.tool_use_id", "tool-2");
  });
});
