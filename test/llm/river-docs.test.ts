import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearModelCatalogFacts,
  clearModelVisionCapabilities,
  modelCatalogFacts,
  modelReasoningEfforts,
  modelSupportsThinking,
  registerModelCatalog,
  resetReasoningKnowledge,
  routeReasoningIsMandatory,
} from "../../src/llm/capabilities.js";
import { resolveContextWindow } from "../../src/llm/context-windows.js";
import {
  isOfficialRiverEndpoint,
  loadRiverDocFacts,
  parseRiverControlsTable,
  parseRiverLimitsTable,
  resetRiverDocFacts,
  riverDocFactsFromMarkdown,
} from "../../src/llm/river-docs.js";
import { riverProvider } from "../../src/llm/river.js";
import { riverModelCatalog } from "../../src/llm/river-models.js";
import { json, REQUEST, transport } from "./river-fixtures.js";

const apiKey = "rv_docs_fixture";
const NEW_MODEL = "acme/Orbit-9-FP8";

const LIMITS = [
  "# Models and pricing",
  "",
  "| Model ID | Context (input + output) | Maximum output |",
  "| --- | ---: | ---: |",
  "| `moonshotai/Kimi-K3` | 1,048,576 tokens | 1,048,575 tokens |",
  "| `GLM-5.3` | 1,048,576 tokens | 128K tokens |",
  `| \`${NEW_MODEL}\` | 786,432 tokens | 65,536 tokens |`,
  "",
  "See the quickstart.",
].join("\n");

const CONTROLS = [
  "# API controls",
  "",
  "| Model | Default reasoning | Chat: `reasoning_effort` | Responses: `reasoning.effort` |",
  "| --- | --- | --- | --- |",
  "| Kimi-K3 | `max` | `none` (off), `low`, `high`, `max` | `none`, `low`, `high`, `max` |",
  "| GLM-5.3 | `max` | `low`, `high`, `max` | `low`, `high`, `max` |",
  "| Orbit-9-FP8 | `medium` | `none` (off), `medium`, `xhigh` | `none`, `medium`, `xhigh` |",
].join("\n");

const markdown = (url: string): Response =>
  new Response(url.endsWith("inference-models.md") ? LIMITS : CONTROLS, {
    headers: { "content-type": "text/markdown" },
  });

beforeEach(() => {
  clearModelCatalogFacts();
  clearModelVisionCapabilities();
  resetReasoningKnowledge();
  resetRiverDocFacts();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearModelCatalogFacts();
  clearModelVisionCapabilities();
  resetReasoningKnowledge();
  resetRiverDocFacts();
});

describe("River docs tables", () => {
  it("parses context, output and efforts, reading K as thousands", () => {
    expect(parseRiverLimitsTable(LIMITS)).toEqual([
      { id: "moonshotai/Kimi-K3", contextTokens: 1_048_576, maxOutputTokens: 1_048_575 },
      { id: "GLM-5.3", contextTokens: 1_048_576, maxOutputTokens: 128_000 },
      { id: NEW_MODEL, contextTokens: 786_432, maxOutputTokens: 65_536 },
    ]);
    expect(parseRiverControlsTable(CONTROLS)).toEqual([
      { name: "Kimi-K3", efforts: ["none", "low", "high", "max"], defaultEffort: "max" },
      { name: "GLM-5.3", efforts: ["low", "high", "max"], defaultEffort: "max" },
      { name: "Orbit-9-FP8", efforts: ["none", "medium", "xhigh"], defaultEffort: "medium" },
    ]);
  });

  it("joins the two tables on the model name without the organisation prefix", () => {
    const facts = riverDocFactsFromMarkdown(LIMITS, CONTROLS);
    expect(facts.get(NEW_MODEL.toLowerCase())).toMatchObject({
      id: NEW_MODEL,
      contextTokens: 786_432,
      maxOutputTokens: 65_536,
      reasoning: { supported: true, mandatory: false, supportedEfforts: ["none", "medium", "xhigh"], defaultEffort: "medium" },
    });
    expect(facts.get("glm-5.3")?.reasoning).toMatchObject({ mandatory: true, supportedEfforts: ["low", "high", "max"] });
  });

  it("drops rows with unusable numbers and efforts outside the known vocabulary", () => {
    const limits = [
      "| Model ID | Context | Maximum output |",
      "| --- | ---: | ---: |",
      "| `a/zero` | 0 tokens | 10 tokens |",
      "| `a/huge` | 999,999,999,999 tokens | 10 tokens |",
      "| `a/tiny` | 100 tokens | 10 tokens |",
      "| `a/over` | 100,000 tokens | 900,000 tokens |",
      "| not-code | 100,000 tokens | 10 tokens |",
    ].join("\n");
    expect(parseRiverLimitsTable(limits)).toEqual([
      { id: "a/over", contextTokens: 100_000, maxOutputTokens: undefined },
    ]);
    const controls = [
      "| Model | Default | Chat |",
      "| --- | --- | --- |",
      "| Odd | `warp` | `warp`, `ludicrous` |",
      "| Mixed | `low` | `low`, `warp`, `high` |",
    ].join("\n");
    expect(parseRiverControlsTable(controls)).toEqual([
      { name: "Mixed", efforts: ["low", "high"], defaultEffort: "low" },
    ]);
  });

  it("returns nothing for pages without the expected tables", () => {
    expect(parseRiverLimitsTable("<html>maintenance</html>")).toEqual([]);
    expect(parseRiverControlsTable("")).toEqual([]);
    expect(riverDocFactsFromMarkdown("{}", "{}").size).toBe(0);
  });

  it("only treats the official River API host as eligible for the docs refresh", () => {
    expect(isOfficialRiverEndpoint("https://api.river.ai/v1")).toBe(true);
    expect(isOfficialRiverEndpoint("https://API.RIVER.AI/v1/")).toBe(true);
    expect(isOfficialRiverEndpoint("https://gateway.example/v1")).toBe(false);
    expect(isOfficialRiverEndpoint("https://api.river.ai.evil.example/v1")).toBe(false);
    expect(isOfficialRiverEndpoint("not a url")).toBe(false);
  });
});

describe("River dynamic model metadata", () => {
  it("gives a model River adds later its documented context window and efforts without a release", async () => {
    transport(undefined, () => json({ data: [{ id: NEW_MODEL, object: "model", owned_by: "river" }] }), markdown);
    expect(await riverProvider.listModels!({ apiKey })).toEqual([NEW_MODEL]);

    expect(modelCatalogFacts("river", NEW_MODEL)).toMatchObject({ contextTokens: 786_432, maxOutputTokens: 65_536 });
    expect(resolveContextWindow({ provider: "river", model: NEW_MODEL })).toMatchObject({ tokens: 786_432, source: "provider" });
    expect(modelReasoningEfforts("river", NEW_MODEL)).toEqual(["none", "medium", "xhigh"]);
    expect(modelSupportsThinking("river", NEW_MODEL)).toBe(true);
    expect(routeReasoningIsMandatory("river", NEW_MODEL)).toBe(false);
  });

  it("lets the published docs correct a bundled value", async () => {
    transport(undefined, () => json({ data: [{ id: "moonshotai/Kimi-K3" }] }), (url) =>
      new Response(url.endsWith("inference-models.md")
        ? LIMITS.replace("| `moonshotai/Kimi-K3` | 1,048,576 tokens", "| `moonshotai/Kimi-K3` | 2,097,152 tokens")
        : CONTROLS));
    await riverProvider.listModels!({ apiKey });
    expect(resolveContextWindow({ provider: "river", model: "moonshotai/Kimi-K3" }).tokens).toBe(2_097_152);
  });

  it("lets live /models metadata override the docs", async () => {
    transport(undefined, () => json({ data: [{ id: NEW_MODEL, context_length: 500_000, supported_reasoning_efforts: ["low"] }] }), markdown);
    await riverProvider.listModels!({ apiKey });
    expect(resolveContextWindow({ provider: "river", model: NEW_MODEL }).tokens).toBe(500_000);
    expect(modelReasoningEfforts("river", NEW_MODEL)).toEqual(["low"]);
    expect(modelCatalogFacts("river", NEW_MODEL)?.maxOutputTokens).toBe(65_536);
  });

  it("keeps bundled facts for every model when the docs are unreachable", async () => {
    transport(undefined, () => json({ data: [{ id: "moonshotai/Kimi-K3" }, { id: "Qwen/Qwen3.8-27B-FP8" }] }), () => new Response("down", { status: 503 }));
    await riverProvider.listModels!({ apiKey });
    expect(resolveContextWindow({ provider: "river", model: "moonshotai/Kimi-K3" }).tokens).toBe(1_048_576);
    expect(resolveContextWindow({ provider: "river", model: "Qwen/Qwen3.8-27B-FP8" }).tokens).toBe(262_144);
    expect(modelReasoningEfforts("river", "Qwen/Qwen3.8-27B-FP8")).toEqual(["none", "low", "medium", "xhigh"]);
  });

  it("does not invent facts for a new model that neither the API nor the docs describe", async () => {
    transport(undefined, () => json({ data: [{ id: "acme/Unlisted-1" }] }), markdown);
    await riverProvider.listModels!({ apiKey });
    expect(modelCatalogFacts("river", "acme/Unlisted-1")?.contextTokens).toBeUndefined();
    expect(modelReasoningEfforts("river", "acme/Unlisted-1")).toBeUndefined();
    expect(modelSupportsThinking("river", "acme/Unlisted-1")).toBe(false);
  });

  it("ignores hostile or oversized docs responses", async () => {
    transport(undefined, () => json({ data: [{ id: NEW_MODEL }] }), () => new Response("x".repeat(600 * 1024)));
    await riverProvider.listModels!({ apiKey });
    expect(modelCatalogFacts("river", NEW_MODEL)?.contextTokens).toBeUndefined();
  });

  it("never contacts the docs host for a custom endpoint", async () => {
    const { docsFetch } = transport(undefined, () => json({ data: [{ id: NEW_MODEL }] }), markdown);
    await riverProvider.listModels!({ apiKey, baseUrl: "https://gateway.example/v1" });
    expect(docsFetch).not.toHaveBeenCalled();
    expect(modelCatalogFacts("river", NEW_MODEL)?.contextTokens).toBeUndefined();
  });

  it("fetches the docs once for concurrent and repeated discovery, and caches a failure", async () => {
    const { docsFetch } = transport(undefined, () => json({ data: [{ id: NEW_MODEL }] }), markdown);
    await Promise.all([riverProvider.listModels!({ apiKey }), riverProvider.listModels!({ apiKey: `${apiKey}2` })]);
    await riverProvider.listModels!({ apiKey });
    expect(docsFetch).toHaveBeenCalledTimes(2);

    resetRiverDocFacts();
    const failing = transport(undefined, undefined, () => new Response("", { status: 500 }));
    expect((await loadRiverDocFacts()).size).toBe(0);
    expect((await loadRiverDocFacts()).size).toBe(0);
    expect(failing.docsFetch).toHaveBeenCalledTimes(2);
  });

  it("does not delay or fail a generation when the docs are down", async () => {
    const { generations } = transport(undefined, undefined, () => new Response("", { status: 500 }));
    const result = await riverProvider.complete(REQUEST, { apiKey });
    expect(result.text).toBe("Answer");
    expect(generations).toHaveLength(1);
  });

  it("applies docs-derived facts through the same registration path as live metadata", () => {
    registerModelCatalog("river", riverModelCatalog(
      { data: [{ id: NEW_MODEL }] },
      riverDocFactsFromMarkdown(LIMITS, CONTROLS),
    ));
    expect(modelReasoningEfforts("river", NEW_MODEL)).toEqual(["none", "medium", "xhigh"]);
  });
});
