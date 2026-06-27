import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy hooks injected into the real modules (other exports preserved so the
// agent runner — which ask.ts imports for parseAllToolCalls — still loads).
const complete = vi.fn();
const runTool = vi.fn();

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return { ...actual, completeWithProvider: (req: unknown) => complete(req) };
});

vi.mock("../src/tools/registry.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../src/tools/registry.js")>();
  return {
    ...actual,
    runToolCall: (call: unknown, opts: unknown) => runTool(call, opts),
  };
});

vi.mock("../src/commands/providers.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../src/commands/providers.js")>();
  return { ...actual, ensureProviderConfigured: async () => {} };
});

const { runAsk } = await import("../src/modes/ask.js");

function reply(text: string) {
  return { text, provider: "nvidia", model: "test-model" };
}

describe("ask mode read-only research loop", () => {
  beforeEach(() => {
    complete.mockReset();
    runTool.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers directly when the model requests no tools", async () => {
    complete.mockResolvedValueOnce(reply("A plain answer."));
    const out = await runAsk("what is 2+2");
    expect(out).toBe("A plain answer.");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("runs an allowed read-only tool, then synthesizes a final answer", async () => {
    complete
      .mockResolvedValueOnce(
        reply('```tool\n{"name":"web.search","args":{"query":"tailwind 4"}}\n```'),
      )
      .mockResolvedValueOnce(reply("Tailwind 4 is faster. [cite]"));
    runTool.mockResolvedValueOnce({ ok: true, output: "search results…" });

    const out = await runAsk("differences in tailwind 4");

    expect(runTool).toHaveBeenCalledTimes(1);
    expect((runTool.mock.calls[0]![0] as { name: string }).name).toBe(
      "web.search",
    );
    expect(out).toBe("Tailwind 4 is faster. [cite]");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("pre-runs web.search for explicit current web-search prompts", async () => {
    complete.mockResolvedValueOnce(reply("Current answer with citation."));
    runTool.mockResolvedValueOnce({ ok: true, output: "fresh search results" });

    const out = await runAsk("do web search and tell the latest data");

    expect(out).toBe("Current answer with citation.");
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toMatchObject({
      name: "web.search",
      args: { maxResults: 5, fetchTop: 2 },
    });
    expect(complete).toHaveBeenCalledTimes(1);
    const messages = (complete.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages;
    expect(messages.at(-1)?.content).toContain("Fresh web.search was run before answering");
  });

  it("pre-runs web.search for volatile role questions even without saying search", async () => {
    complete.mockResolvedValueOnce(reply("The current PM is X, according to current sources."));
    runTool.mockResolvedValueOnce({ ok: true, output: "fresh role results" });

    await runAsk("who is the pm of the uk");

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toMatchObject({
      name: "web.search",
      args: { maxResults: 5, fetchTop: 2 },
    });
  });

  it("never executes a non-allowlisted tool like shell.exec in ask mode", async () => {
    complete.mockResolvedValueOnce(
      reply('```tool\n{"name":"shell.exec","args":{"command":"rm -rf /"}}\n```'),
    );
    const out = await runAsk("please clean up");
    // The disallowed tool is never run; the completion is treated as final.
    expect(runTool).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(out).toContain("shell.exec");
  });

  it("stops researching after the round cap and forces a final answer", async () => {
    // Always ask for another tool; the loop must cap and force a tool-free
    // final answer rather than spinning forever.
    complete.mockResolvedValue(
      reply('```tool\n{"name":"web.search","args":{"query":"loop"}}\n```'),
    );
    runTool.mockResolvedValue({ ok: true, output: "more results" });

    const out = await runAsk("keep going");
    // 5 research rounds + 1 forced final answer = 6 completions.
    expect(complete).toHaveBeenCalledTimes(6);
    expect(typeof out).toBe("string");
  });
});
