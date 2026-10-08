import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearModelCatalogFacts,
  clearModelReasoningEfforts,
  clearModelVisionCapabilities,
  effectiveThinkingEffort,
  modelCatalogFacts,
  modelSupportsThinking,
  modelSupportsVision,
  registerWireRejectionEfforts,
  resetReasoningKnowledge,
  resolveToolDialect,
} from "../src/llm/capabilities.js";
import {
  modelContextWindow,
  modelMaxOutputTokens,
} from "../src/llm/context-windows.js";
import { mistralProvider } from "../src/llm/mistral.js";
import { envVars, normalizeProvider } from "../src/llm/provider.js";
import { resolveBuiltInProfile } from "../src/llm/provider-profiles.js";
import { providers } from "../src/llm/router.js";
import { reasoningOptionValues } from "../src/ui-core/commands/pickers/search-reasoning.js";
import { mistralModelCatalog } from "../src/llm/wire/mistral-model-catalog.js";

let keyIndex = 0;
let apiKey: string;

const small = {
  id: "mistral-small-2603",
  aliases: ["mistral-small-latest"],
  capabilities: {
    completion_chat: true,
    reasoning: true,
    function_calling: true,
    vision: true,
  },
  max_context_length: 262_144,
  default_model_temperature: 0.7,
};

function response(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  apiKey = `mistral-catalog-test-${++keyIndex}`;
  clearModelCatalogFacts();
  clearModelReasoningEfforts();
  clearModelVisionCapabilities();
  resetReasoningKnowledge();
  vi.stubEnv("MISTRAL_BASE_URL", "https://api.mistral.ai/v1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Mistral model discovery", () => {
  it("registers the provider, aliases, environment key, and default model", () => {
    expect(providers.mistral).toBe(mistralProvider);
    expect(normalizeProvider("MISTRAL-AI")).toBe("mistral");
    expect(normalizeProvider("mistralai")).toBe("mistral");
    expect(envVars.mistral).toBe("MISTRAL_API_KEY");
    expect(mistralProvider.defaultModel).toBe("mistral-small-latest");
    expect(
      mistralProvider.validateKey("aBc0123456789DEFGHIJKLMNOPQRS0123"),
    ).toBe(true);
    expect(mistralProvider.validateKey("bad key")).toBe(false);
  });

  it("requires credentials for discovery and validation", async () => {
    await expect(mistralProvider.listModels!({})).rejects.toThrow(
      "Mistral API key is required",
    );
    await expect(mistralProvider.ping({})).rejects.toThrow(
      "Mistral API key is required",
    );
  });

  it("filters non-chat, archived, and internal models and retains aliases and fine-tunes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        data: [
          small,
          { id: "mistral-embed", capabilities: { completion_chat: false } },
          { id: "mistral-ocr", capabilities: { ocr: true } },
          {
            id: "voxtral-transcribe",
            capabilities: { audio_transcription: true },
          },
          { ...small, id: "archived-chat", archived: true, aliases: [] },
          { ...small, id: "internal-chat", internal: true, aliases: [] },
          {
            ...small,
            id: "ft:customer:model",
            root: small.id,
            aliases: ["custom-chat"],
            type: "fine-tuned",
          },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await mistralProvider.listModels!({ apiKey })).toEqual([
      "custom-chat",
      "ft:customer:model",
      "mistral-small-2603",
      "mistral-small-latest",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.mistral.ai/v1/models",
      expect.objectContaining({
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
    expect(reasoningOptionValues("mistral", "custom-chat")).toEqual([
      "off",
      "high",
    ]);
  });

  it("reads served context, output limits, vision, tools, and temperature metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          response({ data: [{ ...small, max_output_tokens: 48_000 }] }),
        ),
    );
    await mistralProvider.listModels!({ apiKey });
    expect(modelContextWindow("mistral-small-latest", "mistral")).toBe(262_144);
    expect(modelMaxOutputTokens("mistral", "mistral-small-latest")).toBe(
      48_000,
    );
    expect(modelSupportsVision("mistral", "mistral-small-latest")).toBe(true);
    expect(
      modelCatalogFacts("mistral", "mistral-small-latest")?.canonicalModel,
    ).toBe(small.id);
    expect(resolveToolDialect("mistral", "mistral-small-latest")).toBe(
      "openai",
    );
    expect(
      resolveBuiltInProfile({
        provider: "mistral",
        model: "mistral-small-latest",
      }),
    ).toMatchObject({
      capabilities: {
        tools: "supported",
        images: "supported",
        streamOptions: "unsupported",
      },
      sampling: { defaults: { temperature: 0.7 } },
      cache: { kind: "affinity-key", affinityField: "prompt_cache_key" },
      limits: { contextTokens: 262_144, outputTokens: 48_000 },
    });
  });

  it("honors explicit unsupported capabilities over model-name patterns", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          data: [
            {
              ...small,
              capabilities: {
                completion_chat: true,
                vision: false,
                reasoning: false,
                function_calling: false,
              },
            },
          ],
        }),
      ),
    );
    await mistralProvider.listModels!({ apiKey });
    expect(modelSupportsVision("mistral", small.id)).toBe(false);
    expect(modelSupportsThinking("mistral", small.id)).toBe(false);
    expect(resolveToolDialect("mistral", small.id)).toBe("none");
    expect(reasoningOptionValues("mistral", small.id)).toEqual(["off"]);
  });

  it("uses documented effort controls without inheriting generic gateway controls", () => {
    expect(reasoningOptionValues("mistral", "mistral-small-latest")).toEqual([
      "off",
      "high",
    ]);
    expect(reasoningOptionValues("mistral", "mistral-medium-3-5")).toEqual([
      "off",
      "high",
    ]);
    expect(reasoningOptionValues("mistral", "mistral-large-4-0")).toEqual([
      "off",
      "high",
    ]);
    expect(reasoningOptionValues("mistral", "mistral-small-2506")).toEqual([
      "off",
    ]);
    expect(reasoningOptionValues("mistral", "zai-glm-5-3")).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(reasoningOptionValues("mistral", "magistral-medium-2509")).toEqual(
      [],
    );
    expect(reasoningOptionValues("mistral", "unrecognized-chat-model")).toEqual(
      ["off"],
    );
    expect(
      effectiveThinkingEffort("mistral", "mistral-small-latest", {
        enabled: true,
        effort: "minimal",
      }),
    ).toBe("high");
  });

  it("prefers a model's explicit entry over conflicting alias metadata", () => {
    const models = mistralModelCatalog({
      data: [
        { ...small, aliases: ["actual-model"] },
        {
          ...small,
          id: "actual-model",
          aliases: [],
          max_context_length: 500_000,
        },
      ],
    });
    expect(
      models.find((model) => model.id === "actual-model")?.facts?.contextTokens,
    ).toBe(500_000);
  });

  it("uses advertised effort vocabulary for newly added models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          data: [
            {
              ...small,
              id: "next-generation-chat",
              aliases: [],
              reasoning: {
                supported_efforts: ["none", "low", "high", "xhigh"],
              },
            },
          ],
        }),
      ),
    );
    await mistralProvider.listModels!({ apiKey });
    expect(reasoningOptionValues("mistral", "next-generation-chat")).toEqual([
      "off",
      "low",
      "high",
      "xhigh",
    ]);
  });

  it("hides unsupported disable controls for newly advertised always-on models", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          data: [
            {
              ...small,
              id: "future-reasoning-model",
              aliases: [],
              reasoning: { supported_efforts: ["low", "high"] },
            },
          ],
        }),
      ),
    );
    await mistralProvider.listModels!({ apiKey });
    expect(reasoningOptionValues("mistral", "future-reasoning-model")).toEqual([
      "low",
      "high",
    ]);
  });

  it("does not invent effort controls from a reasoning capability flag alone", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          data: [{ ...small, id: "future-chat-model", aliases: [] }],
        }),
      ),
    );
    await mistralProvider.listModels!({ apiKey });
    expect(modelSupportsThinking("mistral", "future-chat-model")).toBe(true);
    expect(reasoningOptionValues("mistral", "future-chat-model")).toEqual([]);
    expect(
      resolveBuiltInProfile({ provider: "mistral", model: "future-chat-model" })
        .reasoning.control.status,
    ).toBe("unsupported");
  });

  it("updates effort choices from explicit provider rejection evidence", () => {
    registerWireRejectionEfforts("mistral", "mistral-small-latest", ["none"]);
    expect(reasoningOptionValues("mistral", "mistral-small-latest")).toEqual([
      "off",
    ]);
    expect(
      resolveBuiltInProfile({
        provider: "mistral",
        model: "mistral-small-latest",
      }).reasoning.acceptedEfforts,
    ).toEqual(["none"]);
  });

  it("deduplicates concurrent discovery and rehydrates facts on cache hits", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ data: [small] }));
    vi.stubGlobal("fetch", fetchMock);
    const [first, second] = await Promise.all([
      mistralProvider.listModels!({ apiKey }),
      mistralProvider.listModels!({ apiKey }),
    ]);
    first.push("mutated-by-caller");
    expect(second).not.toContain("mutated-by-caller");
    clearModelCatalogFacts();
    await mistralProvider.listModels!({ apiKey });
    expect(modelCatalogFacts("mistral", small.id)?.contextTokens).toBe(262_144);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("isolates catalog caching by credential and normalized endpoint", async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        response({
          data: [
            {
              ...small,
              max_context_length: url.includes("api.eu.") ? 300_000 : 262_144,
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await mistralProvider.listModels!({ apiKey });
    await mistralProvider.listModels!({ apiKey: `${apiKey}-second` });
    await mistralProvider.listModels!({
      apiKey,
      baseUrl: "https://api.eu.mistral.ai/",
    });
    expect(modelContextWindow(small.id, "mistral")).toBe(300_000);
    await mistralProvider.listModels!({ apiKey });
    expect(modelContextWindow(small.id, "mistral")).toBe(262_144);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes expired catalogs and does not cache discovery failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 503 }))
      .mockResolvedValueOnce(response({ data: [small] }))
      .mockResolvedValueOnce(
        response({ data: [{ ...small, max_context_length: 1_000_000 }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(mistralProvider.listModels!({ apiKey })).rejects.toThrow(
      /503/,
    );
    await mistralProvider.listModels!({ apiKey });
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    await mistralProvider.listModels!({ apiKey });
    expect(modelContextWindow(small.id, "mistral")).toBe(1_000_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
