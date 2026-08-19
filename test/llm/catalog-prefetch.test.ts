import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  prefetchProviderCatalog,
  resetCatalogPrefetchState,
} from "../../src/llm/catalog-prefetch.js";
import { providers } from "../../src/llm/router.js";
import { installFakeTransport } from "../conformance/fake-transport.js";
import { CONFORMANCE_ROUTES } from "../conformance/routes.js";
import { requestForCase } from "../conformance/request-cases.js";

const ROUTE = CONFORMANCE_ROUTES.find(
  (candidate) => candidate.family === "chat_completions",
)!;

beforeEach(() => {
  resetCatalogPrefetchState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetCatalogPrefetchState();
});

describe("catalog prefetch stays off the turn path", () => {
  it("swallows a rejecting /models call", async () => {
    const impl = providers[ROUTE.provider];
    const spy = vi
      .spyOn(impl, "listModels" as never)
      .mockRejectedValue(new Error("models endpoint down"));
    await expect(prefetchProviderCatalog(ROUTE.provider)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("completes a turn while /models rejects", async () => {
    vi.spyOn(providers[ROUTE.provider], "listModels" as never).mockRejectedValue(
      new Error("models endpoint down"),
    );
    const prefetch = prefetchProviderCatalog(ROUTE.provider);
    installFakeTransport({
      family: ROUTE.family,
      mode: "complete",
      scenario: "answer",
      model: ROUTE.model,
    });
    const result = await providers[ROUTE.provider].complete(
      requestForCase(ROUTE, "reasoning-control"),
      ROUTE.auth,
    );
    expect(result).toBeDefined();
    await prefetch;
  });

  it("refetches at most once per TTL window and coalesces concurrent calls", async () => {
    const spy = vi
      .spyOn(providers[ROUTE.provider], "listModels" as never)
      .mockResolvedValue([]);
    const start = 1_000_000;
    await Promise.all([
      prefetchProviderCatalog(ROUTE.provider, { now: start }),
      prefetchProviderCatalog(ROUTE.provider, { now: start }),
    ]);
    await prefetchProviderCatalog(ROUTE.provider, { now: start + 60_000 });
    expect(spy).toHaveBeenCalledTimes(1);
    await prefetchProviderCatalog(ROUTE.provider, { now: start + 60 * 60 * 1000 });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("is a no-op without a provider", async () => {
    await expect(prefetchProviderCatalog(undefined)).resolves.toBeUndefined();
  });
});
