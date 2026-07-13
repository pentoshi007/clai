import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/modes/agent.js";
import { geminiBody } from "../src/llm/gemini.js";
import { estimateTokens } from "../src/agent/context-manager.js";
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

  it("keeps a non-empty assistant turn and disables thinking after a thinking-only reply", async () => {
    const requests: CompletionRequest[] = [];
    stream
      .mockImplementationOnce((request: CompletionRequest, onToken: (token: string) => void) => {
        requests.push(request);
        return reply("<think>reasoned but emitted nothing visible</think>")(request, onToken);
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
    expect(requests[1]!.thinking).toEqual({ enabled: false, effort: "low" });
    const recoveredAssistant = requests[1]!.messages.findLast(
      (message) => message.role === "assistant",
    );
    expect(recoveredAssistant?.content).toBe(
      "[No visible assistant response was produced.]",
    );

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
    expect(thinkingConfig).toEqual({ thinkingLevel: "minimal" });
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

  it("requires web.search immediately after an empty reply to a dated schedule question", async () => {
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
    ).resolves.toBe("Aborted.");

    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages.at(-1)?.content).toContain("web.search now");
  });

  it("uses the compact agent prompt for low-TPM Groq models", async () => {
    let request: CompletionRequest | undefined;
    stream.mockImplementation((nextRequest: CompletionRequest, onToken: (token: string) => void) => {
      request = nextRequest;
      return reply("Done.")(nextRequest, onToken);
    });

    await runAgent("hi", {
      provider: "groq",
      model: "qwen/qwen3-32b",
      session: session("agent-recovery-groq"),
      maxSteps: 1,
    });

    const system = request?.messages[0];
    expect(system).toMatchObject({ role: "system" });
    expect(system?.content).toContain("Call one tool");
    expect(system?.content).not.toContain("SECURITY POSTURE — FULL OFFENSIVE CAPABILITY");
    expect(estimateTokens(system?.content ?? "")).toBeLessThan(2_000);
  });

  it("uses MiniMax M3's recommended agent temperature for Kimchi's short ID", async () => {
    let request: CompletionRequest | undefined;
    stream.mockImplementation((nextRequest: CompletionRequest, onToken: (token: string) => void) => {
      request = nextRequest;
      return reply("Done.")(nextRequest, onToken);
    });

    await runAgent("hi", {
      provider: "kimchi",
      model: "minimax-m3",
      session: session("agent-recovery-minimax"),
      maxSteps: 1,
    });

    expect(request?.temperature).toBe(1);
  });
});
