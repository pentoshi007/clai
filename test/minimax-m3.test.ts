import { afterEach, describe, expect, it, vi } from "vitest";
import { nvidiaProvider } from "../src/llm/nvidia.js";
import { kimchiProvider } from "../src/llm/kimchi.js";

describe("NVIDIA NIM minimax-m3 payload alignment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends minimax-m3 specific payload parameters", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "hello world" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await nvidiaProvider.complete(
      {
        model: "minimaxai/minimax-m3",
        messages: [{ role: "user", content: "hello" }],
      },
      { apiKey: "nvapi-testkey12345678" }
    );

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    const options = fetchCallArgs[1] as RequestInit;
    const body = JSON.parse(options.body as string);

    // Verify minimax-m3 parameters match official docs
    expect(body.model).toBe("minimaxai/minimax-m3");
    expect(body.max_tokens).toBe(8192);
    expect(body.temperature).toBe(1.00);
    expect(body.top_p).toBe(0.95);

    // Verify accept header is set to application/json
    expect(options.headers).toMatchObject({
      "content-type": "application/json",
      "accept": "application/json",
      "authorization": "Bearer nvapi-testkey12345678",
    });
  });

  it("respects user specified temperature and maxTokens for minimax-m3", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "hello world" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await nvidiaProvider.complete(
      {
        model: "minimaxai/minimax-m3",
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.5,
        maxTokens: 100,
      },
      { apiKey: "nvapi-testkey12345678" }
    );

    expect(fetchMock).toHaveBeenCalled();
    const fetchCallArgs = fetchMock.mock.calls[0];
    const options = fetchCallArgs[1] as RequestInit;
    const body = JSON.parse(options.body as string);

    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.5);
    expect(body.top_p).toBe(0.95);
  });

  it("applies MiniMax M3 sampling to Kimchi's short model ID", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "hello world" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await kimchiProvider.complete(
      {
        model: "minimax-m3",
        messages: [{ role: "user", content: "hello" }],
      },
      { apiKey: "kimchi-test-key" },
    );

    const options = fetchMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(options.body as string);
    expect(body.model).toBe("minimax-m3");
    expect(body.max_tokens).toBe(8_192);
    expect(body.temperature).toBe(1);
    expect(body.top_p).toBe(0.95);
  });
});
