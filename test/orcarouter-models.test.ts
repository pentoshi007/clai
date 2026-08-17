import { afterEach, describe, expect, it, vi } from "vitest";
import { orcarouterProvider, orcarouterFallbackModels } from "../src/llm/orcarouter.js";
import {
  defaultModels,
  envVars,
  normalizeProvider,
} from "../src/llm/provider.js";
import { providers } from "../src/llm/router.js";
import { providerCategory } from "../src/store/config.js";
import { providerIds } from "../src/types.js";

describe("OrcaRouter provider registration", () => {
  it("is a fully registered built-in provider", () => {
    expect(providerIds).toContain("orcarouter");
    expect(providers.orcarouter).toBe(orcarouterProvider);
    expect(normalizeProvider("orcarouter")).toBe("orcarouter");
    expect(normalizeProvider("orca-router")).toBe("orcarouter");
    expect(normalizeProvider("orca")).toBe("orcarouter");
    expect(defaultModels.orcarouter).toBe("openai/gpt-4o-mini");
    expect(envVars.orcarouter).toBe("ORCAROUTER_API_KEY");
    // Zero token markup, but per-token billing at provider list price.
    expect(providerCategory.orcarouter).toBe("paid-cloud");
  });

  it("exposes the full provider surface (stream, listModels, ping)", () => {
    expect(typeof orcarouterProvider.stream).toBe("function");
    expect(typeof orcarouterProvider.listModels).toBe("function");
    expect(typeof orcarouterProvider.ping).toBe("function");
    expect(orcarouterProvider.reasoningStyle).toBe("openai");
    expect(orcarouterProvider.envVar).toBe("ORCAROUTER_API_KEY");
  });

  it("validates sk- key shapes", () => {
    expect(orcarouterProvider.validateKey("sk-orca-abc12345")).toBe(true);
    expect(orcarouterProvider.validateKey("sk-12345678")).toBe(true);
    expect(orcarouterProvider.validateKey("nope")).toBe(false);
    expect(orcarouterProvider.validateKey("sk-short")).toBe(false);
  });
});

describe("OrcaRouter model discovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const baseTime = Date.now();

  // Runs first, on an empty module-level cache: once a successful fetch has
  // populated `cachedModels`, a failed refresh intentionally keeps serving the
  // stale cache (same resilience pattern as every other gateway provider), so
  // the fallback list is only observable before any successful fetch.
  it("falls back to the documented catalog when /models is unreachable", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "Invalid API key" } }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Date, "now").mockReturnValue(baseTime);

    const result = await orcarouterProvider.listModels!({
      apiKey: "sk-orca-bad12345",
    });
    expect(result).toEqual(orcarouterFallbackModels);
    expect(result).toContain("openai/gpt-4o-mini");
    expect(result).toContain("orcarouter/auto");
  });

  it("fetches /models with bearer auth and keeps only chat models", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "openai/gpt-4o-mini", supported_endpoint_types: ["openai"] },
              {
                id: "anthropic/claude-sonnet-4.6",
                supported_endpoint_types: ["anthropic", "openai"],
              },
              // Non-chat modalities must stay out of the /model picker.
              { id: "openai/gpt-image-1", supported_endpoint_types: ["openai"] },
              { id: "openai/tts-1", supported_endpoint_types: ["openai"] },
              { id: "kling/kling-v3-omni", supported_endpoint_types: ["kling"] },
              { id: "google/imagen-4.0-generate-001", supported_endpoint_types: ["google"] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    // Past the 1h TTL of any earlier cache entry.
    vi.spyOn(Date, "now").mockReturnValue(baseTime + 3 * 60 * 60 * 1000);

    const result = await orcarouterProvider.listModels!({
      apiKey: "sk-orca-test12345",
    });
    expect(result).toEqual(["anthropic/claude-sonnet-4.6", "openai/gpt-4o-mini"]);

    expect(fetchMock).toHaveBeenCalled();
    const call = fetchMock.mock.calls[0];
    expect(String(call[0])).toBe("https://api.orcarouter.ai/v1/models");
    const options = call[1] as RequestInit;
    expect(options.headers).toMatchObject({
      authorization: "Bearer sk-orca-test12345",
    });
  });

  it("caches the models list for the TTL window", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o-mini" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const time = baseTime + 5 * 60 * 60 * 1000;
    vi.spyOn(Date, "now").mockReturnValue(time);
    await orcarouterProvider.listModels!({ apiKey: "sk-orca-cache1234" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.spyOn(Date, "now").mockReturnValue(time + 10_000);
    const result = await orcarouterProvider.listModels!({
      apiKey: "sk-orca-cache1234",
    });
    expect(result).toEqual(["openai/gpt-4o-mini"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
