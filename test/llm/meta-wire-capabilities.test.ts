import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, ReasoningEffort } from "../../src/types.js";
import { metaProvider } from "../../src/llm/meta.js";
import { clearModelCatalogFacts, registerWireRejectionEfforts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { rememberMainEffort } from "../../src/llm/main-effort-discovery.js";
import { compileRequestPlan } from "../../src/llm/request-plan.js";
import { completeWithProvider, streamWithProvider } from "../../src/llm/router.js";
import { invalidateModelLists } from "../../src/llm/model-list-cache.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import { buildReasoningPayload } from "../../src/llm/wire/reasoning-payload.js";
import { resetEffortPreflightForTesting } from "../../src/llm/wire/effort-preflight.js";
import { reasoningOptionValues } from "../../src/ui-core/commands/pickers/search-reasoning.js";
import { buildWireResponse, jsonResponse, type WireMode } from "../conformance/wire-fixtures.js";

const auth = { apiKey: "fixture-meta-wire-key" };
const efforts: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
const modes: readonly WireMode[] = ["complete", "stream"];

vi.mock("../../src/store/keys.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/store/keys.js")>(),
  getProviderKeys: async () => ({
    keys: [{ id: "env", value: "fixture-meta-wire-key", createdAt: 0 }],
    activeIndex: 0, source: "env" as const,
  }),
}));

function fixture(catalog: () => readonly object[] = () => []) {
  const requests: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith("/models")) return jsonResponse({ data: catalog() });
    if (!url.endsWith("/responses")) throw new Error(`Unexpected Meta endpoint: ${url}`);
    const parsed: unknown = JSON.parse(String(init?.body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid request body");
    const body = parsed as Record<string, unknown>;
    requests.push(body);
    return buildWireResponse("meta_responses", body.stream ? "stream" : "complete", "answer", String(body.model));
  }));
  return requests;
}

function request(model: string, effort: ReasoningEffort = "max"): CompletionRequest {
  return { model, messages: [{ role: "user", content: "Reply briefly." }], thinking: { enabled: true, effort } };
}

async function generate(mode: WireMode, input: CompletionRequest, credentials = auth): Promise<void> {
  if (mode === "complete") {
    expect((await metaProvider.complete(input, credentials)).text).toBe("conformance answer");
    return;
  }
  const tokens: string[] = [];
  const result = await metaProvider.stream(input, credentials, (token) => tokens.push(token));
  expect(result.text).toBe("conformance answer");
  expect(tokens.join("")).toBe("conformance answer");
}

beforeEach(() => {
  resetReasoningKnowledge();
  clearModelCatalogFacts();
  invalidateModelLists("meta");
  resetEffortPreflightForTesting();
});
afterEach(() => {
  resetReasoningKnowledge();
  clearModelCatalogFacts();
  invalidateModelLists("meta");
  resetEffortPreflightForTesting();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(modes)("Meta %s wire capabilities", (mode) => {
  it.each(["muse-wonder-1.0", "muse-spark-1.3"])("preserves every supported selected effort, including literal max, for %s", async (model) => {
    const requests = fixture();
    for (const effort of efforts) {
      await generate(mode, request(model, effort));
      expect(requests.at(-1)).toMatchObject({ model, reasoning: { effort } });
      expect(buildReasoningPayload({ enabled: true, effort }, "meta", model, "meta")).toEqual({ reasoning_effort: effort });
      const profile = resolveBuiltInProfile({ provider: "meta", model });
      expect(buildReasoningPayload({ enabled: true, effort }, "meta", model, "meta", { profile, willReplayReasoning: false }))
        .toEqual({ reasoning_effort: effort });
    }
    expect(requests).toHaveLength(efforts.length);
  });

  it.each(["muse-wonder-1.0", "muse-spark-1.3"])("preserves max through the main-agent router for %s without a probe", async (model) => {
    const requests = fixture();
    const input = { ...request(model), provider: "meta" as const, purpose: "turn" as const };
    if (mode === "complete") await completeWithProvider(input);
    else await streamWithProvider(input, () => undefined);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ model, reasoning: { effort: "max" } });
  });

  it("uses a published vocabulary even when the model is unknown or documented without max", async () => {
    const requests = fixture(() => [
      { id: "future-reasoner", reasoning: { supported_efforts: ["low", "max"] } },
      { id: "muse-spark-1.3-contributor", supported_reasoning_efforts: ["minimal", "max"] },
    ]);
    await metaProvider.listModels!(auth);
    for (const model of ["future-reasoner", "muse-spark-1.3-contributor"]) {
      await generate(mode, request(model));
      expect(requests.at(-1)).toMatchObject({ reasoning: { effort: "max" } });
      expect(reasoningOptionValues("meta", model)).toContain("max");
      expect(buildReasoningPayload({ enabled: true, effort: "max" }, "meta", model, "meta"))
        .toEqual({ reasoning_effort: "max" });
    }
  });

  it.each([false, { supported: false }, { mandatory: true, supported_efforts: [] }])("omits reasoning controls for published %j", async (reasoning) => {
    rememberMainEffort("meta", "muse-wonder-1.0", "max", "high");
    registerWireRejectionEfforts("meta", "muse-wonder-1.0", ["high"]);
    const requests = fixture(() => [{ id: "muse-wonder-1.0", reasoning }]);
    await metaProvider.listModels!(auth);
    await generate(mode, request("muse-wonder-1.0"));
    expect(requests[0]).not.toHaveProperty("reasoning");
    expect(buildReasoningPayload({ enabled: true, effort: "max" }, "meta", "muse-wonder-1.0", "meta")).toEqual({});
  });

  it("refreshes wire constraints without advertising or sending removed effort levels", async () => {
    let accepted = ["low", "max"];
    const requests = fixture(() => [{ id: "muse-wonder-1.0", supported_reasoning_efforts: accepted }]);
    await metaProvider.listModels!(auth);
    await generate(mode, request("muse-wonder-1.0"));
    expect(requests.at(-1)).toMatchObject({ reasoning: { effort: "max" } });
    accepted = ["low", "high"];
    invalidateModelLists("meta");
    await metaProvider.listModels!(auth);
    expect(reasoningOptionValues("meta", "muse-wonder-1.0")).toEqual(accepted);
    await generate(mode, request("muse-wonder-1.0"));
    expect(requests.at(-1)).toMatchObject({ reasoning: { effort: "high" } });
  });

  it("uses request-local cached capabilities for overlapping credentials", async () => {
    let accepted = ["low"];
    const requests = fixture(() => [{ id: "muse-wonder-1.0", supported_reasoning_efforts: accepted }]);
    await metaProvider.listModels!(auth);
    accepted = ["max"];
    const other = { apiKey: "fixture-other-meta-key" };
    await metaProvider.listModels!(other);
    await Promise.all([
      generate(mode, request("muse-wonder-1.0"), auth),
      generate(mode, request("muse-wonder-1.0"), other),
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ reasoning: { effort: "low" } });
    expect(requests[1]).toMatchObject({ reasoning: { effort: "max" } });
  });

  it.each(["muse-wonder-1.0", "future-reasoner"])("does not silently downgrade newly published max on %s", async (model) => {
    rememberMainEffort("meta", model, "max", "high");
    registerWireRejectionEfforts("meta", model, ["high"]);
    const requests = fixture(() => [{ id: model, supported_reasoning_efforts: ["high", "max"] }]);
    await metaProvider.listModels!(auth);
    const input = request(model);
    const plan = compileRequestPlan({ provider: "meta", model, messages: input.messages, reasoning: input.thinking, stream: mode === "stream" });
    expect(plan.controls.reasoning?.effort).toBe("max");
    await generate(mode, input);
    expect(requests[0]).toMatchObject({ reasoning: { effort: "max" } });
    const routed = { ...input, provider: "meta" as const, purpose: "turn" as const };
    if (mode === "complete") await completeWithProvider(routed);
    else await streamWithProvider(routed, () => undefined);
    expect(requests.at(-1)).toMatchObject({ reasoning: { effort: "max" } });
  });

  it("does not probe a published empty effort list", async () => {
    const model = "muse-wonder-1.0";
    const requests = fixture(() => [{ id: model, reasoning: { mandatory: true, supported_efforts: [] } }]);
    await metaProvider.listModels!(auth);
    const routed = { ...request(model), provider: "meta" as const, purpose: "turn" as const };
    if (mode === "complete") await completeWithProvider(routed);
    else await streamWithProvider(routed, () => undefined);
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("reasoning");
  });

  it("uses the supported minimum when disabled on mandatory reasoning models", async () => {
    rememberMainEffort("meta", "muse-wonder-1.0", "max", "high");
    const requests = fixture();
    await generate(mode, { ...request("muse-wonder-1.0"), thinking: { enabled: false, effort: "none" } });
    expect(requests[0]).toMatchObject({ reasoning: { effort: "minimal" } });
    expect(reasoningOptionValues("meta", "muse-wonder-1.0")).not.toContain("off");
  });
});
