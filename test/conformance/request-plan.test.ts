import { beforeEach, describe, expect, it } from "vitest";

import {
  buildChatBody,
  chatCompletionsBodyFromPlan,
} from "../../src/llm/http.js";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";
import { geminiBody } from "../../src/llm/gemini.js";
import {
  compileRequestPlan,
  type CompileRequestPlanInput,
} from "../../src/llm/request-plan.js";
import {
  createReasoningArtifactReplayTarget,
  reasoningArtifactsForMessage,
} from "../../src/llm/reasoning-artifacts.js";
import {
  markReasoningUnsupported,
  resetReasoningKnowledge,
} from "../../src/llm/capabilities.js";
import type { ChatMessage, ProviderId } from "../../src/types.js";
import { CONFORMANCE_ROUTES } from "./routes.js";
import {
  requestForCase,
  REQUEST_CASES,
  type RequestCase,
} from "./request-cases.js";
import type { CompletionRequest } from "../../src/types.js";

beforeEach(() => {
  resetReasoningKnowledge();
});

const CHAT_STYLE_BY_ROUTE: Record<string, string> = {
  free: "none",
  openai: "openai",
  openrouter: "openrouter",
  nvidia: "nvidia",
  agentrouter: "agentrouter",
  bynara: "bynara",
  "qwen-cloud": "openai",
  modal: "modal",
  lightning: "openai",
  tokenrouter: "none",
  fireworks: "openai",
  hetzner: "openai",
  orcarouter: "openai",
  "aws-mantle-compatible": "openai",
};

function requestFor(provider: ProviderId, model: string, requestCase: RequestCase): CompletionRequest {
  return requestForCase(
    { id: "", provider, family: "chat_completions", model, auth: {}, urlContains: "" },
    requestCase,
  );
}

function planInputForCase(
  provider: ProviderId,
  model: string,
  requestCase: RequestCase,
  stream: boolean,
): CompileRequestPlanInput {
  const request = requestFor(provider, model, requestCase);
  return {
    provider,
    model,
    messages: request.messages,
    stream,
    reasoning: request.thinking,
    tools: request.tools,
    toolChoice: request.toolChoice,
    parallelToolCalls: request.parallelToolCalls,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
  };
}

describe("canonical request plan", () => {
  it("exposes deterministic stable/mutable boundaries", () => {
    const input = planInputForCase("nvidia", "meta/llama-3.3-70b-instruct", "tools", true);
    const first = compileRequestPlan(input);
    const second = compileRequestPlan(input);
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.timeline.sections.map((s) => [s.kind, s.messageStart, s.messageEnd])).toEqual([
      ["instructions", 0, 1],
      ["history", 1, 3],
      ["live", 3, 4],
    ]);
  });

  it("keeps the cacheable prefix hash stable while the live turn grows", () => {
    const base: ChatMessage[] = [
      { role: "system", content: "stable system prefix" },
      { role: "user", content: "first user turn" },
      { role: "assistant", content: "first assistant answer" },
    ];
    const turn: ChatMessage[] = [
      { role: "user", content: "read the example file" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call_plan_1",
            name: "fs.read",
            args: { path: "docs/example.md" },
            rawArguments: '{"path":"docs/example.md"}',
          },
        ],
        reasoningBlock: { text: "the file must be inspected first" },
      },
      { role: "tool", content: "example file contents", toolCallId: "call_plan_1", name: "fs.read" },
    ];
    const common = {
      provider: "nvidia" as const,
      model: "llama-3.3-70b-versatile",
      stream: true,
    };
    const opened = compileRequestPlan({
      ...common,
      messages: [...base, turn[0]!],
    });
    const grown = compileRequestPlan({
      ...common,
      messages: [...base, ...turn],
    });
    expect(grown.cache.fingerprint.prefixSha256).toBe(opened.cache.fingerprint.prefixSha256);
    expect(grown.cache.fingerprint.prefixMessageCount).toBe(
      opened.cache.fingerprint.prefixMessageCount,
    );
    expect(
      grown.cache.fingerprint.sections.find((s) => s.section === "instructions")?.sha256,
    ).toBe(opened.cache.fingerprint.sections.find((s) => s.section === "instructions")?.sha256);
    expect(
      grown.cache.fingerprint.sections.find((s) => s.section === "history")?.sha256,
    ).toBe(opened.cache.fingerprint.sections.find((s) => s.section === "history")?.sha256);

    const settled = compileRequestPlan({
      ...common,
      messages: [...base, ...turn, { role: "user", content: "next turn" }],
    });
    expect(settled.cache.fingerprint.prefixSha256).not.toBe(grown.cache.fingerprint.prefixSha256);
    expect(settled.cache.fingerprint.prefixMessageCount).toBeGreaterThan(
      grown.cache.fingerprint.prefixMessageCount,
    );
  });

  it("treats request-context system messages as mutable and excludes them from the prefix", () => {
    const common = {
      provider: "anthropic" as const,
      model: "claude-3-5-haiku-latest",
      stream: false,
    };
    const withContext = (context: string) =>
      compileRequestPlan({
        ...common,
        messages: [
          { role: "system", content: "constitution" },
          { role: "system", content: `REQUEST CONTEXT\n${context}` },
          { role: "user", content: "u1" },
          { role: "assistant", content: "a1" },
          { role: "user", content: "u2" },
        ],
      });
    const first = withContext("plan v1");
    const changed = withContext("plan v2");
    expect(first.timeline.mutableMessageIndexes).toEqual([1, 4]);
    expect(first.cache.fingerprint.prefixMessageCount).toBe(3);
    expect(changed.cache.fingerprint.prefixSha256).toBe(first.cache.fingerprint.prefixSha256);

    const stableChanged = compileRequestPlan({
      ...common,
      messages: [
        { role: "system", content: "constitution" },
        { role: "system", content: "REQUEST CONTEXT\nplan v1" },
        { role: "user", content: "u1" },
        { role: "assistant", content: "different answer" },
        { role: "user", content: "u2" },
      ],
    });
    expect(stableChanged.cache.fingerprint.prefixSha256).not.toBe(
      first.cache.fingerprint.prefixSha256,
    );
  });

  it("gives every timeline artifact exactly one replay decision", () => {
    const input = planInputForCase("openai", "gpt-5.4-mini", "tool-loop-replay", true);
    const plan = compileRequestPlan(input);
    const artifactTotal = input.messages.reduce(
      (sum, message) => sum + reasoningArtifactsForMessage(message).length,
      0,
    );
    expect(artifactTotal).toBeGreaterThan(0);
    expect(plan.replay.decisions).toHaveLength(artifactTotal);
    for (const entry of plan.replay.decisions) {
      expect(entry.decision.action === "replayed" || entry.decision.action === "omitted").toBe(true);
      if (entry.decision.action === "omitted") {
        expect(entry.decision.reason).toBeDefined();
      }
    }
    expect(plan.replay.target.dialect).toBe("openai-compatible");
  });

  it("counts only boundary replayable artifacts in the cache fingerprint", () => {
    const common = {
      provider: "openai" as const,
      model: "gpt-5.4-mini",
      stream: true,
    };
    const artifactMessage: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call_plan_artifact",
          name: "fs.read",
          args: {},
          rawArguments: "{}",
        },
      ],
    };
    const plan = compileRequestPlan({
      ...common,
      messages: [
        { role: "system", content: "s" },
        {
          role: "assistant",
          content: "prior turn",
          reasoningArtifacts: [
            {
              version: 1,
              kind: "plaintext",
              raw: "prior reasoning",
              provenance: {
                provider: "openai",
                model: "gpt-5.4-mini",
                dialect: "openai-compatible",
              },
              replay: { scope: "all-history", persistence: "all-turns" },
              position: { sequence: 0, placement: "assistant" },
              accounting: { byteLength: 14, estimatedTokens: 5 },
            },
          ],
        },
        { role: "user", content: "go" },
        { ...artifactMessage, content: "" },
      ],
      reasoning: { enabled: true, effort: "medium" },
    });
    expect(plan.replay.decisions.filter((d) => d.decision.action === "replayed")).toHaveLength(1);
    expect(plan.cache.fingerprint.replayedArtifactCount).toBe(1);
    expect(
      plan.cache.fingerprint.sections.find((s) => s.section === "artifacts")?.itemCount,
    ).toBe(1);
  });

  it("records reasoning control suppression with its cause", () => {
    const input = planInputForCase("nvidia", "meta/llama-3.3-70b-instruct", "reasoning-control", false);
    markReasoningUnsupported("nvidia", "meta/llama-3.3-70b-instruct");
    const plan = compileRequestPlan(input);
    expect(plan.controls.controlSuppression).toBe("observed-rejection");
    expect(plan.controls.reasoning?.enabled).toBe(true);
    expect(plan.controls.stream).toBe(false);
  });

  it("never carries raw prompt, reasoning, or endpoint data outside the timeline", () => {
    const input = planInputForCase("openai", "gpt-5.4-mini", "tool-loop-replay", true);
    const plan = compileRequestPlan({
      ...input,
      endpoint: "https://secret-gateway.invalid/v1?q=token",
    });
    const metadata = JSON.stringify(plan.route) + JSON.stringify(plan.cache.fingerprint);
    expect(metadata).not.toContain("stable system prefix for cache reuse");
    expect(metadata).not.toContain("the file must be inspected first");
    expect(metadata).not.toContain("secret-gateway.invalid");
    expect(metadata).not.toContain("q=token");
    expect(plan.route.endpointHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("resolves the serializer id and replay dialect for every wire family", () => {
    const cases: Array<{ provider: ProviderId; model: string; serializer: string; dialect: string }> = [
      { provider: "nvidia", model: "meta/llama-3.3-70b-instruct", serializer: "chat-completions", dialect: "openai-compatible" },
      { provider: "anthropic", model: "claude-3-5-haiku-latest", serializer: "anthropic-messages", dialect: "anthropic-messages" },
      { provider: "gemini", model: "gemini-3.5-flash", serializer: "gemini-generate-content", dialect: "gemini-generate-content" },
      { provider: "meta", model: "muse-spark-1.2", serializer: "meta-responses", dialect: "meta-responses" },
      { provider: "ollama", model: "llama3.1:8b", serializer: "ollama-chat", dialect: "ollama-chat" },
    ];
    for (const expected of cases) {
      const plan = compileRequestPlan({
        provider: expected.provider,
        model: expected.model,
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      });
      expect(plan.route.serializer).toBe(expected.serializer);
      expect(plan.replay.target.dialect).toBe(expected.dialect);
      expect(plan.budget.plannedAdmissions).toBe(1);
    }
  });

  it("reports route policy from the resolved provider profile", () => {
    const thinkingCapable = compileRequestPlan({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(thinkingCapable.policy.controlDialect).toBe("anthropic-thinking");
    expect(thinkingCapable.policy.cache.kind).toBe("explicit-breakpoint");
    expect(thinkingCapable.cache.policy.kind).toBe("explicit-breakpoint");

    const preThinking = compileRequestPlan({
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(preThinking.policy.controlDialect).toBe("none");
    expect(preThinking.policy.reasoningGeneration).toBe("none");
    expect(preThinking.cache.policy.kind).toBe("explicit-breakpoint");
  });
});

describe("chat-completions bodies compile from plans", () => {
  const chatRoutes = CONFORMANCE_ROUTES.filter((r) => r.family === "chat_completions");

  const PROFILE_DRIVEN_KEYS: readonly string[] = [
    "max_completion_tokens",
    "max_tokens",
    "temperature",
    "top_p",
    "reasoning",
    "reasoning_budget",
    "reasoning_effort",
    "chat_template_kwargs",
    "enable_thinking",
    "include_reasoning",
    "preserve_thinking",
    "think",
    "thinking",
    "thinkingConfig",
    "thinking_budget",
  ];

  function withoutControlFields(body: string): Record<string, unknown> {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    for (const key of PROFILE_DRIVEN_KEYS) delete parsed[key];
    return parsed;
  }

  it("produces byte-identical bodies to the legacy serializer outside the profile-driven fields", () => {
    for (const route of chatRoutes) {
      const style = (CHAT_STYLE_BY_ROUTE[route.id] ?? "none") as
        | "none"
        | "openai"
        | "nvidia"
        | "openrouter"
        | "nvidia"
        | "agentrouter"
        | "modal"
        | "bynara";
      for (const requestCase of REQUEST_CASES) {
        for (const stream of [false, true]) {
          const request = requestFor(route.provider, route.model, requestCase);
          const plan = compileRequestPlan({
            provider: route.provider,
            model: route.model,
            messages: request.messages,
            stream,
            reasoning: request.thinking,
            tools: request.tools,
            toolChoice: request.toolChoice,
            parallelToolCalls: request.parallelToolCalls,
            temperature: request.temperature,
            maxTokens: request.maxTokens,
          });
          const legacy = buildChatBody({
            model: route.model,
            providerId: route.provider,
            replayTarget: createReasoningArtifactReplayTarget({
              provider: route.provider,
              model: route.model,
              dialect: "openai-compatible",
            }),
            messages: request.messages,
            maxTokens: request.maxTokens,
            temperature: request.temperature,
            stream,
            reasoning: request.thinking,
            reasoningStyle: style,
            supportsVision: plan.images.visionAccepted,
            tools: request.tools,
            toolChoice: request.toolChoice,
            parallelToolCalls: request.parallelToolCalls,
          });
          const planBody = chatCompletionsBodyFromPlan(plan, {
            reasoningStyle: style,
          });
          expect(JSON.stringify(JSON.parse(planBody).messages)).toBe(
            JSON.stringify(JSON.parse(legacy).messages),
          );
          expect(withoutControlFields(planBody)).toEqual(
            withoutControlFields(legacy),
          );
        }
      }
    }
  });

  it("honors serializer-side extras for stream usage and replay observation", () => {
    const input = planInputForCase("openai", "gpt-5.4-mini", "tool-loop-replay", true);
    const plan = compileRequestPlan(input);
    const observed: string[] = [];
    const body = chatCompletionsBodyFromPlan(plan, {
      reasoningStyle: "openai",
      includeStreamUsage: false,
      reasoningArtifactReplayObserver: (decision) => {
        observed.push(decision.action);
      },
    });
    expect(JSON.parse(body).stream_options).toBeUndefined();
    expect(observed.length).toBeGreaterThan(0);
    expect(new Set(observed)).toEqual(new Set(["omitted"]));
  });

  it("keeps family body builders plan-driven and deterministic", () => {
    const request = {
      provider: "anthropic" as const,
      model: "claude-3-5-haiku-latest",
      messages: [
        { role: "system", content: "s".repeat(4100) },
        { role: "user", content: "hi" },
      ],
      maxTokens: 512,
      thinking: { enabled: true, effort: "high" as const },
    };
    expect(buildAnthropicBody(request as never, false)).toBe(buildAnthropicBody(request as never, false));
    expect(JSON.parse(buildAnthropicBody(request as never, false)).thinking).toEqual({
      type: "enabled",
      budget_tokens: 8192,
    });
    const geminiRequest = {
      provider: "gemini" as const,
      model: "gemini-3.5-flash",
      messages: [{ role: "user", content: "hi" }],
    };
    expect(geminiBody(geminiRequest as never, true)).toBe(geminiBody(geminiRequest as never, true));
    expect(JSON.parse(geminiBody(geminiRequest as never, true)).contents).toEqual([
      { role: "user", parts: [{ text: "hi" }] },
    ]);
  });
});
