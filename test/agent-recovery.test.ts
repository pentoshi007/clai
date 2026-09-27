import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/modes/agent.js";
import { geminiBody } from "../src/llm/gemini.js";
import { samplingDefaults } from "../src/llm/sampling.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import type { CompletionRequest } from "../src/types.js";

const stream = vi.fn();

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (request: unknown, onToken: (token: string) => void) =>
      stream(request, onToken),
  };
});

vi.mock("../src/commands/providers.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

function reply(text: string) {
  return (request: CompletionRequest, onToken: (token: string) => void) => {
    onToken(text);
    return Promise.resolve({
      text,
      provider: request.provider ?? "gemini",
      model: request.model ?? "test-model",
    });
  };
}

function session(sessionId: string) {
  return {
    sessionId,
    planApproved: { value: false },
    allow: new Set(),
    pentestAuthorized: { value: false },
  } as any;
}

describe("agent recovery request shaping", () => {
  const configBefore = getConfig();

  beforeEach(() => {
    stream.mockReset();
    updateConfig({ thinking: { enabled: true, effort: "low" } });
  });

  afterEach(() => {
    updateConfig({ thinking: configBefore.thinking });
  });

  it("keeps a non-empty assistant turn and preserves reasoning after a thinking-only reply", async () => {
    const longReasoning =
      "First I mapped the xray opacity rules per system: external parts drop to 0.10 when xray is on and the part belongs to the current system. " +
      "Then I checked the muscular layer: it is outside the current system but xray still applies, so it should fade to 0.25 instead of hiding.";
    const requests: CompletionRequest[] = [];
    stream
      .mockImplementationOnce((request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(request);
        return reply(`<think>${longReasoning}</think>`)(request, onToken);
      })
      .mockImplementationOnce((request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(request);
        return reply("Visible recovery answer.")(request, onToken);
      });

    await runAgent("Please answer this.", {
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
      session: session("agent-recovery-thinking"),
      maxSteps: 1,
    });

    expect(requests).toHaveLength(2);
    expect(requests[1]!.thinking).toEqual({ enabled: true, effort: "low" });
    const recoveredAssistant = requests[1]!.messages.findLast(
      (message) => message.role === "assistant",
    );
    expect(recoveredAssistant?.content).toBe(
      "[No visible assistant response was produced.]",
    );

    const nudge = requests[1]!.messages.at(-1);
    expect(nudge?.role).toBe("user");
    expect(nudge?.content).toContain("preserved_reasoning");
    expect(nudge?.content).toContain("xray opacity rules");

    const body = JSON.parse(geminiBody(requests[1]!)) as {
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>;
    };
    const modelParts = body.contents
      .filter((content) => content.role === "model")
      .flatMap((content) => content.parts);
    expect(modelParts.some((part) => part.text === "")).toBe(false);

    const thinkingConfig = (body as {
      generationConfig: { thinkingConfig?: Record<string, unknown> };
    }).generationConfig.thinkingConfig;
    expect(thinkingConfig).toEqual({ thinkingLevel: "low", includeThoughts: true });
  });

  it("recovers a Kiro reasoning-only turn without forcing compaction", async () => {
    updateConfig({ thinking: { enabled: true, effort: "medium" } });
    const reasoning =
      "I traced the Kiro tool execution state, checked the pending task, and preserved the exact next action so the retry can continue without restarting the analysis or duplicating the original request.";
    const prompt = "Continue the current task.";
    const requests: CompletionRequest[] = [];
    stream
      .mockImplementationOnce(
        (request: CompletionRequest, onToken: (token: string) => void) => {
          requests.push(request);
          return reply(`<think>${reasoning}</think>`)(request, onToken);
        },
      )
      .mockImplementationOnce(
        (request: CompletionRequest, onToken: (token: string) => void) => {
          requests.push(request);
          return reply("Visible Kiro recovery answer.")(request, onToken);
        },
      );

    await runAgent(prompt, {
      provider: "kiro",
      model: "claude-opus-5.5-thinking",
      session: session("agent-recovery-kiro-thinking"),
      maxSteps: 1,
    });

    expect(requests.map((request) => request.purpose)).toEqual([
      "turn",
      "turn",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.purpose === "turn")).toBe(true);
    expect(requests[1]!.thinking).toEqual(requests[0]!.thinking);
    expect(
      requests[1]!.messages.filter(
        (message) =>
          message.role === "user" && message.content === prompt,
      ),
    ).toHaveLength(1);
    expect(requests[1]!.messages.at(-1)?.content).toContain(
      "Your previous response contained only reasoning",
    );
  });

  it("recovers Kiro after repeated same-effort reasoning-only replies", async () => {
    updateConfig({ thinking: { enabled: true, effort: "medium" } });
    const requests: CompletionRequest[] = [];
    const reasoning =
      "I retained the complete Kiro recovery state and the next action, but this simulated generation still did not emit a visible answer or tool call.";
    stream.mockImplementation(
      (request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(request);
        return requests.length <= 4
          ? reply(`<think>${reasoning}</think>`)(request, onToken)
          : reply("Visible answer after repeated Kiro reasoning.")(request, onToken);
      },
    );

    await runAgent("Continue once.", {
      provider: "kiro",
      model: "claude-opus-5.5-thinking",
      session: session("agent-recovery-kiro-bounded"),
      maxSteps: 1,
    });

    expect(requests).toHaveLength(5);
    expect(requests.every((request) => request.thinking?.effort === "medium")).toBe(true);
    expect(
      requests[4]!.messages.filter(
        (message) => message.role === "user" && message.content === "Continue once.",
      ),
    ).toHaveLength(1);
  });

  it("recovers Kiro after repeated true-empty stream errors", async () => {
    updateConfig({ thinking: { enabled: true, effort: "medium" } });
    const requests: CompletionRequest[] = [];
    stream.mockImplementation(
      (request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(request);
        if (requests.length <= 2) {
          return Promise.reject(
            new Error(
              "No provider could stream the request. — kiro: Kiro completed without a visible answer.",
            ),
          );
        }
        return reply("Visible answer after repeated Kiro empty streams.")(request, onToken);
      },
    );

    await runAgent("Continue after an empty stream.", {
      provider: "kiro",
      model: "claude-opus-5.5-thinking",
      session: session("agent-recovery-kiro-empty-bounded"),
      maxSteps: 1,
    });

    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.purpose === "turn")).toBe(true);
    expect(requests.every((request) => request.thinking?.effort === "medium")).toBe(true);
    expect(
      requests[2]!.messages.filter(
        (message) =>
          message.role === "user" && message.content === "Continue after an empty stream.",
      ),
    ).toHaveLength(1);
  });

  it("keeps the selected reasoning effort across repeated thinking-only replies", async () => {
    const firstReasoning =
      "First long reasoning pass: I mapped the xray opacity rules per system and concluded external parts drop to 0.10 when xray is on and the part belongs to the current system selection.";
    const secondReasoning =
      "Second reasoning pass: I rechecked the muscular layer fade logic and confirmed it sits outside the current system but xray still applies, so it should fade rather than hide.";
    const requests: CompletionRequest[] = [];
    stream
      .mockImplementationOnce((request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(request);
        return reply(`<think>${firstReasoning}</think>`)(request, onToken);
      })
      .mockImplementationOnce((request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(request);
        return reply(`<think>${secondReasoning}</think>`)(request, onToken);
      })
      .mockImplementationOnce((request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(request);
        return reply("Visible recovery answer.")(request, onToken);
      });

    await runAgent("Please answer this.", {
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
      session: session("agent-recovery-thinking-twice"),
      maxSteps: 1,
    });

    expect(requests).toHaveLength(3);
    expect(requests[1]!.thinking).toEqual({ enabled: true, effort: "low" });
    expect(requests[2]!.thinking).toEqual({ enabled: true, effort: "low" });
    const firstNudge = requests[1]!.messages.at(-1)?.content ?? "";
    const secondNudge = requests[2]!.messages.at(-1)?.content ?? "";
    expect(firstNudge).toContain("xray opacity rules");
    expect(secondNudge).toContain("preserved_reasoning");
    expect(secondNudge).toContain("muscular layer fade logic");
  });

  it("drops empty Gemini turns and coalesces adjacent user content", () => {
    const body = JSON.parse(
      geminiBody({
        model: "gemini-3.1-flash-lite",
        messages: [
          { role: "user", content: "Original question" },
          { role: "assistant", content: "" },
          { role: "user", content: "Answer visibly now" },
        ],
      }),
    ) as { contents: Array<{ role: string; parts: Array<{ text?: string }> }> };

    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "Original question" }, { text: "Answer visibly now" }],
      },
    ]);
  });

  it("keeps empty-reply recovery model-directed for a dated schedule question", async () => {
    const requests: CompletionRequest[] = [];
    const controller = new AbortController();
    const snapshot = (request: CompletionRequest): CompletionRequest => ({
      ...request,
      messages: request.messages.map((message) => ({ ...message })),
    });
    stream
      .mockImplementationOnce((request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(snapshot(request));
        return reply("<think>I should search for the date.</think>")(request, onToken);
      })
      .mockImplementationOnce((request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(snapshot(request));
        controller.abort(new Error("test complete"));
        return Promise.reject(controller.signal.reason);
      });

    await expect(
      runAgent("when is SSC CGL 2026", {
        provider: "gemini",
        model: "gemini-3.1-flash-lite",
        session: session("agent-recovery-schedule"),
        maxSteps: 2,
        signal: controller.signal,
      }),
    ).resolves.toBe("");

    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)?.content).toContain("appropriate tool now");
    expect(requests[1]!.messages.at(-1)?.content).not.toContain("web.search");
    expect(requests[1]!.toolChoice).toBe("auto");
  });

  it("leaves sampling to the provider policy instead of pinning 0.2 (LLM-010)", async () => {
    let request: CompletionRequest | undefined;
    stream.mockImplementation((nextRequest: CompletionRequest, onToken: (token: string) => void) => {
      request = nextRequest;
      return reply("Done.")(nextRequest, onToken);
    });

    await runAgent("hi", {
      provider: "tokenrouter",
      model: "MiniMax-M3",
      session: session("agent-recovery-minimax"),
      maxSteps: 1,
    });

    // The runner no longer overrides sampling; llm/sampling.ts resolves it per
    // model inside the provider (MiniMax M3 → 1.0, top_p 0.95).
    expect(request?.temperature).toBeUndefined();
    expect(
      samplingDefaults({ provider: "tokenrouter", model: "MiniMax-M3" }),
    ).toEqual({ temperature: 1.0, topP: 0.95 });
  });
});
