import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Spy hooks injected into the real modules (other exports preserved so the
// agent runner — which ask.ts imports for parseAllToolCalls — still loads).
const stream = vi.fn();
const runTool = vi.fn();

vi.mock("../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/llm/router.js")>();
  return {
    ...actual,
    streamWithProvider: (req: unknown, onToken: (t: string) => void) =>
      stream(req, onToken),
  };
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

// Ask mode streams each round: emit the round's text through onToken (as the
// real provider stream would) and resolve with the matching CompletionResult.
function streamReply(text: string) {
  return (_req: unknown, onToken: (t: string) => void) => {
    onToken(text);
    return Promise.resolve({ text, provider: "nvidia", model: "test-model" });
  };
}

describe("ask mode read-only research loop", () => {
  beforeEach(() => {
    stream.mockReset();
    runTool.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers directly when the model requests no tools", async () => {
    stream.mockImplementationOnce(streamReply("A plain answer."));
    const out = await runAsk("what is 2+2");
    expect(out).toBe("A plain answer.");
    expect(stream).toHaveBeenCalledTimes(1);
    expect(runTool).not.toHaveBeenCalled();
  });

  it("runs an allowed read-only tool, then synthesizes a final answer", async () => {
    stream
      .mockImplementationOnce(
        streamReply('```tool\n{"name":"web.search","args":{"query":"tailwind 4"}}\n```'),
      )
      .mockImplementationOnce(streamReply("Tailwind 4 is faster. [cite]"));
    runTool.mockResolvedValueOnce({ ok: true, output: "search results…" });

    const out = await runAsk("differences in tailwind 4");

    expect(runTool).toHaveBeenCalledTimes(1);
    expect((runTool.mock.calls[0]![0] as { name: string }).name).toBe(
      "web.search",
    );
    expect(out).toBe("Tailwind 4 is faster. [cite]");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("searches local files through one restricted shell call and preserves the request catalog", async () => {
    const call = { name: "shell.exec", args: { command: "rg -n -- 'answer' src", cwd: "/project" } };
    const reply = (text: string) => async (request: unknown, onToken: (token: string) => void) => ({
      ...await streamReply(text)(request, onToken), provider: "openai", model: "gpt-4o-mini",
    });
    stream.mockImplementationOnce(reply('```tool\n' + JSON.stringify(call) + '\n```'))
      .mockImplementationOnce(reply("The answer is exported by src/example.ts."));
    runTool.mockResolvedValueOnce({ ok: true, output: "src/example.ts:1:export const answer = 42;" });
    const out = await runAsk("inspect the answer export", { provider: "openai", model: "gpt-4o-mini" });
    expect(out).toContain("src/example.ts");
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toEqual(call);
    expect(stream).toHaveBeenCalledTimes(2);
    const [first, second] = stream.mock.calls.map(([request]) => request);
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(second.tools).toEqual(first.tools);
    const shell = first.tools.find((tool: { name: string }) => tool.name === "shell.exec");
    expect(Object.keys(shell.parameters.properties)).toEqual(["command", "cwd", "timeoutMs"]);
    expect(shell.description).toContain("Read-only local inspection");
  });

  it("feeds image.view pixels back as a user image turn before synthesis", async () => {
    const image = {
      mediaType: "image/png",
      dataBase64: "iVBORw0KGgo=",
      path: "/tmp/render.png",
    };
    stream
      .mockImplementationOnce(
        streamReply('```tool\n{"name":"image.view","args":{"path":"/tmp/render.png"}}\n```'),
      )
      .mockImplementationOnce((request: { messages: Array<{ role: string; images?: unknown[]; content: string }> }, onToken: (text: string) => void) => {
        const imageTurn = request.messages.find((message) => message.images?.length);
        expect(imageTurn).toMatchObject({
          role: "user",
          images: [image],
        });
        expect(imageTurn?.content).toMatch(/actual pixels|attached now/i);
        onToken("The render is visible.");
        return Promise.resolve({
          text: "The render is visible.",
          provider: "openai",
          model: "gpt-4o-mini",
        });
      });
    runTool.mockResolvedValueOnce({
      ok: true,
      output: "image attached",
      images: [image],
    });

    const out = await runAsk("inspect /tmp/render.png", {
      provider: "openai",
      model: "gpt-4o-mini",
    });

    expect(out).toBe("The render is visible.");
    expect(runTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "image.view" }),
      expect.objectContaining({
        llmProvider: "nvidia",
        llmModel: "test-model",
      }),
    );
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("pre-runs web.search for explicit current web-search prompts", async () => {
    stream.mockImplementationOnce(streamReply("Current answer with citation."));
    runTool.mockResolvedValueOnce({ ok: true, output: "fresh search results" });

    const out = await runAsk("do web search and tell the latest data");

    expect(out).toBe("Current answer with citation.");
    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toMatchObject({
      name: "web.search",
      args: { maxResults: 5, fetchTop: 2 },
    });
    expect(stream).toHaveBeenCalledTimes(1);
    const messages = (stream.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages;
    expect(messages.at(-1)?.content).toContain("Fresh web.search was run before answering");
  });

  it("pre-runs web.search for volatile role questions even without saying search", async () => {
    stream.mockImplementationOnce(streamReply("The current PM is X, according to current sources."));
    runTool.mockResolvedValueOnce({ ok: true, output: "fresh role results" });

    await runAsk("who is the pm of the uk");

    expect(runTool).toHaveBeenCalledTimes(1);
    expect(runTool.mock.calls[0]![0]).toMatchObject({
      name: "web.search",
      args: { maxResults: 5, fetchTop: 2 },
    });
  });

  it("hands off mutating shell commands without executing them", async () => {
    stream.mockImplementationOnce(
      streamReply('```tool\n{"name":"shell.exec","args":{"command":"rm -rf /"}}\n```'),
    );
    const out = await runAsk("please clean up");
    // The disallowed tool is never run; the completion is treated as final.
    expect(runTool).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(1);
    expect(out).toContain("shell.exec");
  });

  it("stops researching after the round cap and forces a final answer", async () => {
    // Always ask for another tool; the loop must cap and force a tool-free
    // final answer rather than spinning forever.
    stream.mockImplementation(
      streamReply('```tool\n{"name":"web.search","args":{"query":"loop"}}\n```'),
    );
    runTool.mockResolvedValue({ ok: true, output: "more results" });

    const out = await runAsk("keep going");
    // 5 research rounds + 1 forced final answer = 6 completions.
    expect(stream).toHaveBeenCalledTimes(6);
    expect(typeof out).toBe("string");
  });
});
