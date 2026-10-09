import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/llm/http.js";
import {
  SERVER_ERROR_MAX_ATTEMPTS,
  networkRetryWaitMs,
} from "../../src/llm/routing/error-classification.js";
import { completeWithProvider, streamWithProvider, providers } from "../../src/llm/router.js";
import type { LlmProvider, ProviderAuth } from "../../src/llm/provider.js";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";

let hetznerKeyCount = 1;

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/store/keys.js")
  >();
  return {
    ...actual,
    getProviderKeys: async (provider: Parameters<typeof actual.getProviderKeys>[0]) => {
      if (provider === "free") return {
        keys: [{ id: "keyless", value: "", createdAt: 0 }],
        activeIndex: 0,
        source: "local" as const,
      };
      if (provider !== "hetzner") return actual.getProviderKeys(provider);
      const keys = Array.from({ length: hetznerKeyCount }, (_, index) => ({
        id: `env-${index}`,
        value: `gsk_test_${index}`,
        createdAt: 0,
      }));
      return { keys, activeIndex: 0, source: "env" as const };
    },
  };
});

const originalHetzner = providers.hetzner;
const originalFree = providers.free;
const messages = [{ role: "user" as const, content: "hi" }];

function hetznerAlwaysRateLimited() {
  let calls = 0;
  providers.hetzner = {
    ...originalHetzner,
    async stream() {
      calls += 1;
      throw new ProviderError(
        "Provider request failed with HTTP 429 (retry after 30s)",
        429,
        "",
        0.001,
      );
    },
  } as LlmProvider;
  return () => calls;
}

function hetznerAlwaysUnavailable() {
  let calls = 0;
  providers.hetzner = {
    ...originalHetzner,
    async stream() {
      calls += 1;
      throw new ProviderError(
        "Provider request failed with HTTP 503 (retry after 0.001s)",
        503,
        "",
        0.001,
      );
    },
  } as LlmProvider;
  return () => calls;
}

function freeAlwaysUnavailable() {
  let calls = 0;
  providers.free = {
    ...originalFree,
    async stream() {
      calls += 1;
      throw new ProviderError(
        "Free (model=mimo-v2.6-flash-free): upstream error (retry after 0.001s)",
        503,
        "",
        0.001,
      );
    },
  } as LlmProvider;
  return () => calls;
}

const request = {
  provider: "hetzner" as const,
  model: "test-model",
  messages,
};

const freeRequest = {
  provider: "free" as const,
  model: "step-5-preview-free",
  messages,
};

function freeRateLimitedThenSuccessful(failures = Number.POSITIVE_INFINITY) {
  const calls = vi.fn(async (): Promise<CompletionResult> => {
    if (calls.mock.calls.length <= failures) {
      throw new ProviderError(
        "Free (model=step-5-preview-free): Provider request failed with HTTP 429 — Upstream request failed: Endpoint is unavailable.",
        429,
        '{"error":{"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}}',
        0,
      );
    }
    return { text: "recovered", provider: "free" as const, model: freeRequest.model };
  });
  providers.free = { ...originalFree, complete: calls, stream: calls };
  return calls;
}

afterEach(() => {
  providers.hetzner = originalHetzner;
  providers.free = originalFree;
  hetznerKeyCount = 1;
  vi.unstubAllGlobals();
});

describe("router retry ownership for agent streams", () => {
  it("rethrows the first rate limit on a single-slot route without waiting", async () => {
    const calls = hetznerAlwaysRateLimited();
    await expect(
      streamWithProvider(request, () => {}, { retryRateLimits: false }),
    ).rejects.toThrow(/429/);
    expect(calls()).toBe(1);
  });

  it("rotates every key once before giving a rate limit back to the caller", async () => {
    hetznerKeyCount = 2;
    const calls = hetznerAlwaysRateLimited();
    await expect(
      streamWithProvider(request, () => {}, { retryRateLimits: false }),
    ).rejects.toThrow(/429/);
    expect(calls()).toBe(2);
  });

  it("stops non-rate-limit server failures after the attempt budget", async () => {
    const calls = hetznerAlwaysUnavailable();
    await expect(
      streamWithProvider(request, () => {}, { retryRateLimits: false }),
    ).rejects.toThrow(/503/);
    expect(calls()).toBe(SERVER_ERROR_MAX_ATTEMPTS);
  });

  it("stops default router rate-limit retries after four retries", async () => {
    const calls = hetznerAlwaysRateLimited();
    await expect(streamWithProvider(request, () => {})).rejects.toThrow(/429/);
    expect(calls()).toBe(5);
  });

  it.each(["stream", "complete"] as const)(
    "retries transient Free 429 failures in standalone %s requests",
    async (mode) => {
      const calls = freeRateLimitedThenSuccessful(2);
      const onStatus = vi.fn();
      const result = mode === "stream"
        ? await streamWithProvider(freeRequest, () => {}, { onStatus })
        : await completeWithProvider(freeRequest, { onStatus });
      expect(result.text).toBe("recovered");
      expect(calls).toHaveBeenCalledTimes(3);
      expect(onStatus.mock.calls.filter(([status]) => status.includes("retrying in"))).toHaveLength(2);
    },
  );

  it.each(["stream", "complete"] as const)(
    "bounds standalone Free %s rate-limit retries to three",
    async (mode) => {
      const calls = freeRateLimitedThenSuccessful();
      const result = mode === "stream"
        ? streamWithProvider(freeRequest, () => {})
        : completeWithProvider(freeRequest);
      await expect(result).rejects.toMatchObject({ status: 429 });
      expect(calls).toHaveBeenCalledTimes(4);
    },
  );

  it.each([
    { retryRateLimits: false },
    { singleDispatch: true },
    { maxRetries: 0 },
  ])("honors caller-owned or disabled Free retry policy: %j", async (options) => {
    const calls = freeRateLimitedThenSuccessful();
    await expect(streamWithProvider(freeRequest, () => {}, options)).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("does not transparently replay Free output after a stream starts", async () => {
    const stream = vi.fn(async (_request: CompletionRequest, _auth: ProviderAuth, onToken: (token: string) => void) => {
      onToken("partial answer");
      throw new ProviderError("rate limited", 429, "", 0);
    });
    providers.free = { ...originalFree, stream };
    const onToken = vi.fn();
    await expect(streamWithProvider(freeRequest, onToken)).rejects.toMatchObject({ status: 429 });
    expect(stream).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledExactlyOnceWith("partial answer");
  });

  it("retries Free server errors three times with 1s, 2s, 4s waits, then fails", async () => {
    expect(networkRetryWaitMs(0)).toBe(1_000);
    expect(networkRetryWaitMs(1)).toBe(2_000);
    expect(networkRetryWaitMs(2)).toBe(4_000);
    const calls = freeAlwaysUnavailable();
    await expect(
      streamWithProvider(
        {
          provider: "free",
          model: "free-1/mimo-v2.6-flash-free",
          messages,
        },
        () => {},
      ),
    ).rejects.toThrow(/503/);
    expect(calls()).toBe(4);
  });
});
