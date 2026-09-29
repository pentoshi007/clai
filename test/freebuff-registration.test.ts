import { afterEach, describe, expect, it, vi } from "vitest";

import { providerIds } from "../src/types.js";
import {
  getDefaultModel,
  getProviderInfoText,
  normalizeProvider,
} from "../src/llm/provider.js";
import { getProvider, providers } from "../src/llm/routing/provider-selection.js";
import { resolveProviderCategory } from "../src/store/config.js";
import { resolveToolDialect } from "../src/llm/capability/tool-dialect.js";
import { isKnownPatternVisionModel } from "../src/llm/capability/vision-patterns.js";
import { fetchFreebuffModelIds, resetFreebuffCatalogCache } from "../src/llm/freebuff-models.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetFreebuffCatalogCache();
});

describe("Freebuff provider registration", () => {
  it("is a first-class provider id with aliases and a default model", () => {
    expect(providerIds).toContain("freebuff");
    expect(normalizeProvider("freebuff")).toBe("freebuff");
    expect(normalizeProvider("fb")).toBe("freebuff");
    expect(normalizeProvider("free-buff")).toBe("freebuff");
    expect(getDefaultModel("freebuff")).toBe("z-ai/glm-5.3-flash");
  });

  it("resolves to its own provider instead of falling through to nvidia", () => {
    const provider = getProvider("freebuff");
    expect(provider.id).toBe("freebuff");
    expect(providers.freebuff).toBe(provider);
    expect(typeof provider.complete).toBe("function");
    expect(typeof provider.stream).toBe("function");
    expect(typeof provider.listModels).toBe("function");
    expect(provider.envVar).toBe("FREEBUFF_API_KEY");
  });

  it("is categorized as free cloud and described in /info", () => {
    expect(resolveProviderCategory("freebuff")).toBe("free-cloud");
    const info = getProviderInfoText("freebuff");
    expect(info).toContain("Freebuff");
    expect(info).toContain("clai auth freebuff");
    expect(info).toContain("wallet spend");
  });

  it("uses the OpenAI tool dialect and recognizes reasoning/vision models", () => {
    expect(resolveToolDialect("freebuff", "openai/gpt-5.6-luna")).toBe("openai");
    expect(isKnownPatternVisionModel("freebuff", "openai/gpt-5.6-luna")).toBe(true);
    expect(isKnownPatternVisionModel("freebuff", "anthropic/claude-opus-5")).toBe(true);
    expect(isKnownPatternVisionModel("freebuff", "deepseek/deepseek-v4-pro")).toBe(false);
  });
});

describe("Freebuff dynamic catalog", () => {
  it("lists only the dynamically applicable ids without hardcoded extras", async () => {
    resetFreebuffCatalogCache();
    vi.stubGlobal(
      "fetch",
      (async () =>
        json(200, {
          status: "none",
          rateLimitsByModel: { "anthropic/claude-opus-5": {}, "vendor/new-model": {} },
          freebucks: { prices: { "openai/gpt-6-sol": 0 } },
        })) as typeof fetch,
    );

    const ids = await fetchFreebuffModelIds("freebuff-catalog-token-0001");
    expect(ids).toContain("vendor/new-model");
    expect(ids).toContain("openai/gpt-6-sol");
    expect(ids).not.toContain("deepseek/deepseek-v4-pro");
  });

  it("excludes plan-gated models from the applicable list", async () => {
    resetFreebuffCatalogCache();
    vi.stubGlobal(
      "fetch",
      (async () =>
        json(200, {
          status: "none",
          rateLimitsByModel: {
            "mimo/mimo-v2.5": {},
            "mimo/mimo-v2.6-pro": {},
          },
          freebucks: {
            prices: { "mimo/mimo-v2.5": 10, "mimo/mimo-v2.6-pro": 30 },
            planRequiredModelIds: ["mimo/mimo-v2.6-pro"],
          },
        })) as typeof fetch,
    );

    const ids = await fetchFreebuffModelIds("freebuff-catalog-token-0004");
    expect(ids).toContain("mimo/mimo-v2.5");
    expect(ids).not.toContain("mimo/mimo-v2.6-pro");
  });

  it("serves the cached catalog when the probe fails after a success", async () => {
    resetFreebuffCatalogCache();
    vi.stubGlobal(
      "fetch",
      (async () =>
        json(200, { status: "none", rateLimitsByModel: { "cached/model": {} } })) as typeof fetch,
    );
    const first = await fetchFreebuffModelIds("freebuff-catalog-token-0002");
    expect(first).toContain("cached/model");

    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    );
    const second = await fetchFreebuffModelIds("freebuff-catalog-token-0002");
    expect(second).toContain("cached/model");
  });

  it("falls back to the static table when there is no cache and the probe fails", async () => {
    resetFreebuffCatalogCache();
    vi.stubGlobal(
      "fetch",
      (async () => {
        throw new Error("network down");
      }) as typeof fetch,
    );
    const ids = await fetchFreebuffModelIds("freebuff-catalog-token-0003");
    expect(ids).toContain("deepseek/deepseek-v4-pro");
    expect(ids).toContain("openai/gpt-5.6-luna");
  });

  it("isolates visible models for tokens sharing prefix and length", async () => {
    resetFreebuffCatalogCache();
    const tokenA = "sharedxx-account-token-one";
    const tokenB = "sharedxx-account-token-two";
    expect(tokenA.slice(0, 8)).toBe(tokenB.slice(0, 8));
    expect(tokenA.length).toBe(tokenB.length);
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const token = new Headers(init?.headers).get("authorization");
      const model = token === `Bearer ${tokenA}` ? "account-a/model" : "account-b/model";
      return json(200, { status: "none", rateLimitsByModel: { [model]: {} } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const modelsA = await fetchFreebuffModelIds(tokenA);
    const modelsB = await fetchFreebuffModelIds(tokenB);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(modelsA).toContain("account-a/model");
    expect(modelsA).not.toContain("account-b/model");
    expect(modelsB).toContain("account-b/model");
    expect(modelsB).not.toContain("account-a/model");
  });

  it("coalesces concurrent catalog probes for the same token", async () => {
    resetFreebuffCatalogCache();
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return json(200, { status: "none", rateLimitsByModel: { "account/model": {} } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [first, second, third] = await Promise.all([
      fetchFreebuffModelIds("freebuff-coalesce-token-1"),
      fetchFreebuffModelIds("freebuff-coalesce-token-1"),
      fetchFreebuffModelIds("freebuff-coalesce-token-1"),
    ]);

    expect(calls).toBe(1);
    expect(first).toContain("account/model");
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });
});
