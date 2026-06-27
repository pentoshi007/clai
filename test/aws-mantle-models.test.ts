import { afterEach, describe, expect, it, vi } from "vitest";
import { mantleProvider } from "../src/llm/aws-mantle.js";

describe("AWS Mantle model discovery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("accepts the models response shape used by Mantle deployments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      models: [{ id: "anthropic.claude-sonnet-4-6" }, "anthropic.claude-haiku-4-5"],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(mantleProvider.listModels?.({ apiKey: "test-key" })).resolves.toEqual([
      "anthropic.claude-haiku-4-5",
      "anthropic.claude-sonnet-4-6",
    ]);
  });

  it("uses the OpenAI-compatible chat endpoint for non-Anthropic Mantle models", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "ok" } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(mantleProvider.complete({
      provider: "aws-mantle",
      model: "moonshotai.kimi-k2.5",
      messages: [{ role: "user", content: "hi" }],
    }, { apiKey: "test-key" })).resolves.toMatchObject({
      text: "ok",
      provider: "aws-mantle",
      model: "moonshotai.kimi-k2.5",
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/v1/chat/completions");
  });

  it("keeps Claude/Anthropic Mantle models on the Anthropic messages endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "ok" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await mantleProvider.complete({
      provider: "aws-mantle",
      model: "anthropic.claude-haiku-4-5",
      messages: [{ role: "user", content: "hi" }],
    }, { apiKey: "test-key" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/anthropic/v1/messages");
  });
});
