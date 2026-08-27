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
      messages: [
        { role: "system", content: "stable ".repeat(800) },
        { role: "user", content: "hi" },
      ],
    }, { apiKey: "test-key" });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/anthropic/v1/messages");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      system: Array<Record<string, unknown>>;
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body).not.toHaveProperty("cache_control");
    expect(body.system[0]).toMatchObject({
      type: "text",
      cache_control: { type: "ephemeral" },
    });
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "hi",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });
});

describe("AWS Mantle prompt cache placement", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps mutable suffix messages after the explicit conversation breakpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: "text", text: "ok" }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await mantleProvider.complete({
      provider: "aws-mantle",
      model: "anthropic.claude-haiku-4-5",
      messages: [
        { role: "system", content: "stable ".repeat(800) },
        { role: "user", content: "request" },
        { role: "assistant", content: "stable answer" },
        { role: "system", content: "ACTIVE PLAN v2\nmutable" },
        { role: "user", content: "recovery", internal: true },
      ],
    }, { apiKey: "test-key" });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    const marked = body.messages.filter((message) =>
      JSON.stringify(message).includes('"cache_control"'),
    );
    expect(marked).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "stable answer",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
    expect(JSON.stringify(body.messages.slice(-2))).not.toContain(
      '"cache_control"',
    );
  });
});
