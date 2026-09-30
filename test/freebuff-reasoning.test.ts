import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReasoningEffort, ReasoningPreference } from "../src/types.js";
import { freebuffProvider } from "../src/llm/freebuff.js";
import { FREEBUFF_STATIC_MODEL_IDS } from "../src/llm/freebuff-models.js";
import { resolveBuiltInProfile } from "../src/llm/provider-profiles.js";
import { compileRequestPlan } from "../src/llm/request-plan.js";
import { chatCompletionsBodyFromPlan } from "../src/llm/wire/chat-body.js";
import { reasoningOptionValues } from "../src/ui-core/commands/pickers/search-reasoning.js";

const ENDPOINT = "https://www.codebuff.com/api/v1";
const TOKEN = "freebuff-reasoning-opaque-token-123456";

const DEPTHS: readonly ReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const VENDOR_NATIVE_CONTROLS = [
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "thinking_budget",
  "reasoning_budget",
  "chat_template_kwargs",
] as const;

const UNPUBLISHED_EFFORT_MODELS = [
  "anthropic/claude-opus-5",
  "google/gemini-3.7-flash",
  "x-ai/grok-4.7",
  "vendor/not-yet-catalogued",
] as const;

function wireBody(
  model: string,
  reasoning: ReasoningPreference,
): Record<string, unknown> {
  const plan = compileRequestPlan({
    provider: "freebuff",
    model,
    messages: [{ role: "user", content: "hello" }],
    stream: true,
    endpoint: ENDPOINT,
    reasoning,
  });
  return JSON.parse(
    chatCompletionsBodyFromPlan(plan, { reasoningStyle: "openrouter" }),
  ) as Record<string, unknown>;
}

function frame(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-reasoning",
    object: "chat.completion.chunk",
    model: "anthropic/claude-opus-5",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  })}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Freebuff reasoning controls", () => {
  it("speaks the gateway's nested reasoning dialect on every catalogued model", () => {
    for (const model of FREEBUFF_STATIC_MODEL_IDS) {
      const { control } = resolveBuiltInProfile({ provider: "freebuff", model }).reasoning;
      expect({ model, dialect: control.dialect, status: control.status }).toEqual({
        model,
        dialect: "openai-nested-reasoning",
        status: "supported",
      });
    }
  });

  it("never leaks a vendor-native reasoning control onto the gateway", () => {
    for (const model of FREEBUFF_STATIC_MODEL_IDS) {
      const preferences: readonly ReasoningPreference[] = [
        { enabled: false, effort: "medium" },
        ...DEPTHS.map((effort) => ({ enabled: true, effort })),
      ];
      for (const preference of preferences) {
        const body = wireBody(model, preference);
        expect(body).toHaveProperty("reasoning");
        for (const control of VENDOR_NATIVE_CONTROLS) {
          expect(body, `${model} ${preference.effort}`).not.toHaveProperty(control);
        }
      }
    }
  });

  it("delivers the selected effort unchanged when a model publishes no effort list", () => {
    for (const model of UNPUBLISHED_EFFORT_MODELS) {
      for (const effort of DEPTHS) {
        expect(wireBody(model, { enabled: true, effort }).reasoning).toEqual({
          enabled: true,
          effort,
        });
      }
    }
  });

  it("keeps a model's published effort list authoritative", () => {
    const kimi = (effort: ReasoningEffort): unknown =>
      wireBody("moonshotai/kimi-k3", { enabled: true, effort }).reasoning;
    expect(kimi("minimal")).toEqual({ enabled: true, effort: "low" });
    expect(kimi("medium")).toEqual({ enabled: true, effort: "high" });
    expect(kimi("xhigh")).toEqual({ enabled: true, effort: "max" });
  });

  it("disables reasoning explicitly, except where the model cannot be switched off", () => {
    const off: ReasoningPreference = { enabled: false, effort: "high" };
    expect(wireBody("anthropic/claude-opus-5", off).reasoning).toEqual({ enabled: false });
    expect(wireBody("deepseek/deepseek-v4-pro", off).reasoning).toEqual({ enabled: false });
    expect(wireBody("moonshotai/kimi-k3", off).reasoning).toEqual({
      enabled: true,
      effort: "low",
    });
  });

  it("offers the whole scale where nothing is published and the published list elsewhere", () => {
    expect(reasoningOptionValues("freebuff", "anthropic/claude-opus-5")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(reasoningOptionValues("freebuff", "moonshotai/kimi-k3")).toEqual([
      "low",
      "high",
      "max",
    ]);
  });
});

describe("Freebuff provider reasoning on the wire", () => {
  it("sends the chosen effort and surfaces the reasoning the gateway returns", async () => {
    const generations: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/freebuff/session/admission")) {
          return new Response(JSON.stringify({ error: "session_superseded" }), { status: 409 });
        }
        if (url.includes("/agent-runs")) {
          return new Response(JSON.stringify({ runId: "run-reasoning" }), { status: 200 });
        }
        generations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const frames = [
          frame({ role: "assistant" }),
          frame({ reasoning: "weighing " }),
          frame({ reasoning: "the options" }),
          frame({ content: "done" }),
          frame({}, "stop"),
          "data: [DONE]\n\n",
        ];
        return new Response(frames.join(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }),
    );

    const result = await freebuffProvider.stream!(
      {
        provider: "freebuff",
        model: "anthropic/claude-opus-5",
        messages: [{ role: "user", content: "think hard" }],
        thinking: { enabled: true, effort: "xhigh" },
      },
      { apiKey: TOKEN },
      () => {},
    );

    expect(generations).toHaveLength(1);
    expect(generations[0]!.reasoning).toEqual({ enabled: true, effort: "xhigh" });
    expect(result.text).toBe("done");
    expect(result.reasoningBlock?.text).toBe("weighing the options");
  });
});
