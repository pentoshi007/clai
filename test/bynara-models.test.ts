import { afterEach, describe, expect, it, vi } from "vitest";
import { bynaraProvider } from "../src/llm/bynara.js";
import { getToolDefinitions } from "../src/tools/definitions.js";

describe("Bynara model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  it("calls fetch on the models endpoint and parses model ids", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "mimo-v2.5-free" }, { id: "mimo-v2.5-pro-free" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await bynaraProvider.listModels!({ apiKey: "test-key" });
    expect(result).toEqual([
      "mimo-v2.5-free",
      "mimo-v2.5-pro-free",
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    expect(String(fetchCallArgs[0])).toContain("/models");
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).toMatchObject({
      "authorization": "Bearer test-key",
    });
  });

  it("works without an API key (public endpoint)", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "mimo-v2.5-free" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass cache by setting time to 2 hours after baseTime
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 2 * 60 * 60 * 1000);

    const result = await bynaraProvider.listModels!({});
    expect(result).toEqual(["mimo-v2.5-free"]);

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    const options = fetchCallArgs[1] as RequestInit;
    expect(options.headers).not.toHaveProperty("authorization");
  });

  it("caches the models list", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "mimo-v2.5-free" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    // Bypass cache by setting time to 5 hours after baseTime
    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await bynaraProvider.listModels!({});
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second call within TTL (10 seconds later)
    vi.spyOn(Date, "now").mockReturnValue(time + 10000);
    const result = await bynaraProvider.listModels!({});
    expect(result).toEqual(["mimo-v2.5-free"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends complete tool-result content to Tencent HY3", async () => {
    const output = `BEGIN-${"x".repeat(16_000)}-END`;
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await bynaraProvider.complete(
      {
        model: "tencent-hy3",
        messages: [
          { role: "user", content: "Read the file." },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_read", name: "fs.read", args: { path: "/tmp/a.txt" } },
            ],
          },
          {
            role: "tool",
            toolCallId: "call_read",
            name: "fs.read",
            content: output,
          },
        ],
        tools: getToolDefinitions({ names: ["fs.read"] }),
      },
      { apiKey: "test-key" },
    );

    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      messages: Array<{ role: string; content?: string }>;
    };
    expect(body.messages.find((message) => message.role === "tool")?.content).toBe(output);
  });

  async function bodyFor(model: string, thinking: { enabled: boolean; effort: string }) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "memory" }, finish_reason: "stop" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await bynaraProvider.complete(
      {
        model,
        messages: [{ role: "user", content: "Summarize this session." }],
        maxTokens: 1_024,
        thinking,
      },
      { apiKey: "test-key" },
    );
    const request = fetchMock.mock.calls[0]![1] as RequestInit;
    return JSON.parse(String(request.body)) as {
      max_tokens: number;
      chat_template_kwargs?: { thinking?: boolean };
      reasoning_effort?: string;
    };
  }

  it("disables kimi-k3 thinking via chat_template_kwargs when off", async () => {
    const body = await bodyFor("kimi-k3-free", { enabled: false, effort: "medium" });
    expect(body.chat_template_kwargs).toEqual({ thinking: false });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("never sends a medium reasoning_effort to kimi-k3 (it rejects it)", async () => {
    const body = await bodyFor("kimi-k3-free", { enabled: true, effort: "medium" });
    expect(body.chat_template_kwargs).toEqual({ thinking: true });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("maps deepseek reasoning on to a high effort", async () => {
    const body = await bodyFor("deepseek-v4-flash-free", { enabled: true, effort: "high" });
    expect(body.reasoning_effort).toBe("high");
    expect(body.chat_template_kwargs).toBeUndefined();
  });

  it("turns deepseek reasoning off with reasoning_effort none", async () => {
    const body = await bodyFor("deepseek-v4-flash-free", { enabled: false, effort: "none" });
    expect(body.reasoning_effort).toBe("none");
  });

  it("sends no reasoning knob for stepfun when disabled (ByNara cannot disable it)", async () => {
    const body = await bodyFor("stepfun-3.7-flash", { enabled: false, effort: "none" });
    expect(body.reasoning_effort).toBeUndefined();
    expect(body.chat_template_kwargs).toBeUndefined();
  });
});
