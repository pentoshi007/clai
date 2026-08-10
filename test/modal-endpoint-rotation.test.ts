import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult } from "../src/types.js";
import type { ProviderAuth } from "../src/llm/provider.js";
import { ProviderError } from "../src/llm/http.js";
import type { ProviderKeyEvent } from "../src/llm/key-rotation.js";

const EP1 = "https://ws-one--ep-kimi.us-west.modal.direct/v1";
const EP2 = "https://ws-two--ep-kimi.us-west.modal.direct/v1";
const KEY1 = "wk-aaa111:ws-secret111";
const KEY2 = "wk-bbb222:ws-secret222";
const GROQ_KEY1 = "gsk_test1111";
const GROQ_KEY2 = "gsk_test2222";

const modalComplete = vi.fn();
const groqComplete = vi.fn();

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

vi.mock("../src/llm/groq.js", () => ({
  groqProvider: {
    id: "groq",
    displayName: "Groq",
    defaultModel: "llama-3.3-70b-versatile",
    validateKey: () => true,
    ping: async () => undefined,
    complete: (request: CompletionRequest, auth: ProviderAuth) =>
      groqComplete(request, auth) as Promise<CompletionResult>,
  },
}));

let modalKeys: Array<{ id: string; value: string; createdAt: number }> = [];
let groqKeys: Array<{ id: string; value: string; createdAt: number }> = [];
let endpointUrls: string[] = [EP1, EP2];

vi.mock("../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => ({
      keys: provider === "modal" ? modalKeys : groqKeys,
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
    getProviderEndpoints: (provider: string) =>
      provider === "modal"
        ? { urls: endpointUrls, activeIndex: 0 }
        : { urls: [], activeIndex: 0 },
    getActiveProviderEndpoint: () => endpointUrls[0] ?? "",
  };
});

function request(): CompletionRequest {
  return {
    provider: "modal",
    model: "moonshotai/Kimi-K3",
    messages: [{ role: "user", content: "hi" }],
  };
}

function groqRequest(): CompletionRequest {
  return {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
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

function groqOk(): CompletionResult {
  return {
    text: "groq-ok",
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    finishReason: "stop",
  };
}

describe("modal endpoint + key rotation", () => {
  beforeEach(() => {
    modalComplete.mockReset();
    groqComplete.mockReset();
    endpointUrls = [EP1, EP2];
    modalKeys = [
      { id: "k1", value: KEY1, createdAt: 0 },
      { id: "k2", value: KEY2, createdAt: 0 },
    ];
    groqKeys = [
      { id: "g1", value: GROQ_KEY1, createdAt: 0 },
      { id: "g2", value: GROQ_KEY2, createdAt: 0 },
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

  describe("single endpoint", () => {
    beforeEach(() => {
      endpointUrls = [EP1];
    });

    it("rotates keys on server errors without moving the only endpoint", async () => {
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
      for (const call of modalComplete.mock.calls) {
        expect(call[1]).toMatchObject({ baseUrl: EP1 });
      }
      expect(modalComplete.mock.calls[2]![1]).toMatchObject({ apiKey: KEY2 });
      expect(events.some((event) => event.type === "endpoint")).toBe(false);
    });

    it("rotates keys on auth errors without moving the only endpoint", async () => {
      modalComplete
        .mockRejectedValueOnce(new ProviderError("revoked", 401))
        .mockResolvedValueOnce(ok());

      const events: ProviderKeyEvent[] = [];
      const { completeWithProvider } = await import("../src/llm/router.js");
      const result = await completeWithProvider(request(), {
        maxRetries: 0,
        onKeyEvent: (event) => events.push(event),
      });

      expect(result.text).toBe("ok");
      expect(modalComplete).toHaveBeenCalledTimes(2);
      expect(modalComplete.mock.calls[0]![1]).toMatchObject({
        apiKey: KEY1,
        baseUrl: EP1,
      });
      expect(modalComplete.mock.calls[1]![1]).toMatchObject({
        apiKey: KEY2,
        baseUrl: EP1,
      });
      expect(events.some((event) => event.type === "endpoint")).toBe(false);
    });
  });

  describe("provider without endpoints", () => {
    it("rotates keys with no baseUrl in auth and no endpoint events", async () => {
      groqComplete
        .mockRejectedValueOnce(new ProviderError("server error", 500))
        .mockRejectedValueOnce(new ProviderError("server error", 500))
        .mockResolvedValueOnce(groqOk());

      const events: ProviderKeyEvent[] = [];
      const { completeWithProvider } = await import("../src/llm/router.js");
      const result = await completeWithProvider(groqRequest(), {
        maxRetries: 0,
        onKeyEvent: (event) => events.push(event),
      });

      expect(result.text).toBe("groq-ok");
      expect(groqComplete).toHaveBeenCalledTimes(3);
      expect(groqComplete.mock.calls[0]![1]).toMatchObject({
        apiKey: GROQ_KEY1,
      });
      expect(groqComplete.mock.calls[2]![1]).toMatchObject({
        apiKey: GROQ_KEY2,
      });
      for (const call of groqComplete.mock.calls) {
        expect(call[1]).not.toHaveProperty("baseUrl");
      }
      expect(events.some((event) => event.type === "endpoint")).toBe(false);
    });
  });
});
