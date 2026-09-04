import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderError } from "../../src/llm/http.js";
import { streamWithProvider, providers } from "../../src/llm/router.js";
import type { LlmProvider } from "../../src/llm/provider.js";

let hetznerKeyCount = 1;

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../src/store/keys.js")
  >();
  return {
    ...actual,
    getProviderKeys: async (provider: Parameters<typeof actual.getProviderKeys>[0]) => {
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

const request = {
  provider: "hetzner" as const,
  model: "test-model",
  messages,
};

afterEach(() => {
  providers.hetzner = originalHetzner;
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

  it("still retries non-rate-limit failures in router ownership", async () => {
    const calls = hetznerAlwaysUnavailable();
    await expect(
      streamWithProvider(request, () => {}, { retryRateLimits: false }),
    ).rejects.toThrow(/503/);
    expect(calls()).toBe(7);
  });

  it("keeps rate-limit retries in default router ownership", async () => {
    const calls = hetznerAlwaysRateLimited();
    await expect(streamWithProvider(request, () => {})).rejects.toThrow(/429/);
    expect(calls()).toBe(7);
  });
});
