import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult } from "../src/types.js";
import type { ProviderAuth } from "../src/llm/provider.js";
import { ProviderError } from "../src/llm/http.js";
import type { ProviderKeyEvent } from "../src/llm/key-rotation.js";

const EP1 = "https://ws-one--ep-kimi.us-west.modal.direct/v1";
const EP2 = "https://ws-two--ep-kimi.us-west.modal.direct/v1";
const KEY1 = "wk-aaa111:ws-secret111";
const KEY2 = "wk-bbb222:ws-secret222";

const modalComplete = vi.fn();

vi.mock("../src/llm/modal.js", () => ({
  modalProvider: {
    id: "modal",
    displayName: "Modal",
    defaultModel: "moonshotai/Kimi-K3",
    validateKey: () => true,
    ping: async () => undefined,
    complete: (request: CompletionRequest, auth: ProviderAuth) =>
      modalComplete(request, auth) as Promise<CompletionResult>,
  },
}));

let modalKeys: Array<{ id: string; value: string; createdAt: number }> = [];

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async () => ({
      keys: modalKeys,
      activeIndex: 0,
      source: "fallback",
    }),
    getProviderSecret: async () => ({
      value: KEY1,
      source: "fallback" as const,
    }),
    markProviderKeySuccess: async () => undefined,
  };
});

vi.mock("../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/config.js")>();
  return {
    ...actual,
    getConfig: () => ({
      ...actual.getConfig(),
      defaultProvider: "modal",
      defaultModel: "moonshotai/Kimi-K3",
      providerFallback: false,
      freeOnly: false,
    }),
    getCustomProviders: () => [],
    providerUsesEndpoints: (provider: string) => provider === "modal",
    getProviderEndpoints: () => ({ urls: [EP1, EP2], activeIndex: 0 }),
    getActiveProviderEndpoint: () => EP1,
  };
});

function request(): CompletionRequest {
  return {
    provider: "modal",
    model: "moonshotai/Kimi-K3",
    messages: [{ role: "user", content: "hi" }],
  };
}

function ok(): CompletionResult {
  return {
    text: "ok",
    provider: "modal",
    model: "moonshotai/Kimi-K3",
    finishReason: "stop",
  };
}

describe("modal endpoint + key rotation", () => {
  beforeEach(() => {
    modalComplete.mockReset();
    modalKeys = [
      { id: "k1", value: KEY1, createdAt: 0 },
      { id: "k2", value: KEY2, createdAt: 0 },
    ];
  });

  it("pairs the next key with the next endpoint after rate-limit/server errors", async () => {
    modalComplete
      .mockRejectedValueOnce(new ProviderError("server error", 500))
      .mockRejectedValueOnce(new ProviderError("server error", 500))
      .mockResolvedValueOnce(ok());

    const events: ProviderKeyEvent[] = [];
    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), {
      maxRetries: 0,
      onKeyEvent: (event) => events.push(event),
    });

    expect(result.text).toBe("ok");
    expect(modalComplete).toHaveBeenCalledTimes(3);
    expect(modalComplete.mock.calls[0]![1]).toMatchObject({
      apiKey: KEY1,
      baseUrl: EP1,
    });
    expect(modalComplete.mock.calls[1]![1]).toMatchObject({
      apiKey: KEY1,
      baseUrl: EP1,
    });
    expect(modalComplete.mock.calls[2]![1]).toMatchObject({
      apiKey: KEY2,
      baseUrl: EP2,
    });
    expect(events.some((event) => event.type === "endpoint")).toBe(true);
  });

  it("keeps the auth-error endpoint rotation restarting the key circle", async () => {
    modalComplete
      .mockRejectedValueOnce(new ProviderError("wrong workspace", 401))
      .mockRejectedValueOnce(new ProviderError("wrong workspace", 401))
      .mockResolvedValueOnce(ok());

    const { completeWithProvider } = await import("../src/llm/router.js");
    const result = await completeWithProvider(request(), { maxRetries: 0 });

    expect(result.text).toBe("ok");
    expect(modalComplete).toHaveBeenCalledTimes(3);
    expect(modalComplete.mock.calls[0]![1]).toMatchObject({
      apiKey: KEY1,
      baseUrl: EP1,
    });
    expect(modalComplete.mock.calls[1]![1]).toMatchObject({
      apiKey: KEY1,
      baseUrl: EP2,
    });
    expect(modalComplete.mock.calls[2]![1]).toMatchObject({
      apiKey: KEY2,
      baseUrl: EP2,
    });
  });

  it("does not advance the endpoint for a single key", async () => {
    modalKeys = [{ id: "k1", value: KEY1, createdAt: 0 }];
    modalComplete.mockRejectedValue(new ProviderError("server error", 500));

    const { completeWithProvider } = await import("../src/llm/router.js");
    await expect(
      completeWithProvider(request(), { maxRetries: 0 }),
    ).rejects.toThrow();
    expect(modalComplete).toHaveBeenCalledTimes(1);
    expect(modalComplete.mock.calls[0]![1]).toMatchObject({
      apiKey: KEY1,
      baseUrl: EP1,
    });
  });
});
