import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";
import { runAgent, createSessionPolicy } from "../../src/modes/agent.js";
import { SubagentManager } from "../../src/agent/subagents/manager.js";

const stream = vi.hoisted(() => vi.fn());

vi.mock("../../src/llm/router.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/llm/router.js")>(),
  streamWithProvider: (request: CompletionRequest, onToken: (text: string) => void) => stream(request, onToken),
}));
vi.mock("../../src/commands/providers.js", () => ({ ensureProviderConfigured: async () => undefined }));

const managers: SubagentManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  stream.mockReset();
});

describe("parent turn subagent delivery", () => {
  it.each(["completed", "error"] as const)("suspends a premature final answer until the child is %s", async (status) => {
    let settle: (() => void) | undefined;
    let childSignal: AbortSignal | undefined;
    const manager = new SubagentManager(`delivery-loop-${status}`, {
      worker: (input) => new Promise<string>((resolve, reject) => {
        childSignal = input.signal;
        settle = () => status === "completed" ? resolve("Verified delegated finding") : reject(new Error("Delegated provider failed"));
      }),
    });
    managers.push(manager);
    manager.setEnabled(true);
    manager.start({ title: "Research", prompt: "Inspect the delegated implementation", provider: "openai", model: "gpt-4o-mini", cwd: process.cwd() });
    const session = createSessionPolicy(manager.parentSessionId);
    session.subagents = manager;
    let waited = false;
    stream.mockImplementation(async (request: CompletionRequest, onToken: (text: string) => void): Promise<CompletionResult> => {
      if (stream.mock.calls.length === 1) {
        expect(request.messages.some((message) => message.content.startsWith("Read-only subagent result arrived."))).toBe(false);
        return { provider: "openai", model: "gpt-4o-mini", text: "Waiting for the delegated investigation.", finishReason: "stop" };
      }
      expect(waited).toBe(true);
      const evidence = request.messages.find((message) => message.content.startsWith("Read-only subagent result arrived."));
      expect(evidence?.content).toContain(status === "completed" ? "Verified delegated finding" : "Delegated provider failed");
      onToken("The delegated investigation has settled.");
      return { provider: "openai", model: "gpt-4o-mini", text: "The delegated investigation has settled.", finishReason: "stop" };
    });
    const answer = await runAgent("Explain the delegated implementation once its research finishes.", {
      session,
      provider: "openai",
      model: "gpt-4o-mini",
      maxSteps: 4,
      onEvent: (event) => {
        if (event.type === "status" && event.text === "waiting for delegated work") {
          expect(stream).toHaveBeenCalledOnce();
          waited = true;
          settle!();
        }
      },
    });
    expect(answer).toBe("The delegated investigation has settled.");
    expect(stream).toHaveBeenCalledTimes(2);
    expect(childSignal?.aborted).toBe(false);
    expect(manager.pendingResults()).toEqual([]);
  });
});
