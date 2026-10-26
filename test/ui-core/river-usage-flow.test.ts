import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearModelCatalogFacts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { RIVER_DEFAULT_MODEL, RIVER_GLM_MODEL } from "../../src/llm/river-models.js";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { handleUsage } from "../../src/ui-core/commands/session-commands.js";

vi.mock("../../src/store/keys.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/store/keys.js")>(),
  getProviderKeys: async () => ({ keys: [{ id: "fixture", value: "rv_usage_fixture", createdAt: 0 }], activeIndex: 0, source: "env" as const }),
  getProviderSecret: async () => ({ value: "rv_usage_fixture", source: "env" as const }),
  markProviderKeySuccess: async () => {},
}));

let services: AppServices | undefined;
let generation = 0;
let reportUsage = true;

function frame(payload: object): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

beforeEach(() => {
  generation = 0;
  reportUsage = true;
  clearModelCatalogFacts();
  resetReasoningKnowledge();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return Response.json({ data: [
      { id: RIVER_DEFAULT_MODEL, context_length: 1_048_576 },
      { id: RIVER_GLM_MODEL, context_length: 1_048_576 },
    ] });
    if (!url.endsWith("/chat/completions") || typeof init?.body !== "string")
      throw new Error(`Unexpected integration request: ${url}`);
    const body: { stream?: boolean; stream_options?: { include_usage?: boolean } } = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    generation += 1;
    const usage = reportUsage && body.stream_options?.include_usage
      ? frame({ choices: [], usage: {
          prompt_tokens: generation * 120,
          completion_tokens: generation * 30,
          total_tokens: generation * 150,
          prompt_tokens_details: { cached_tokens: generation * 80 },
          completion_tokens_details: { reasoning_tokens: generation * 10 },
        } })
      : "";
    return new Response(
      frame({ choices: [{ delta: { content: "RIVER_USAGE_OK" }, finish_reason: "stop" }] }) +
      usage + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  }));
});

afterEach(() => {
  services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});

function start(model = RIVER_DEFAULT_MODEL): AppServices {
  services = createCompositionRoot({
    provider: "river", model, mode: "ask", noHistory: true, captureEvents: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  });
  return services;
}

const prompt = "Reply with exactly RIVER_USAGE_OK. Do not call tools.";

describe("River usage through the production session", () => {
  it.each([RIVER_DEFAULT_MODEL, RIVER_GLM_MODEL])("updates context and /usage for %s", async (model) => {
    const app = start(model);
    expect(await app.session.submit(prompt)).toMatchObject({ status: "completed" });
    expect(app.session.getState().contextUsage).toMatchObject({ contextTokens: 120, lastCompletionTokens: 30, exact: true });
    expect(app.session.getState().contextChip).toContain("120");
    expect(app.session.usageReport().totals).toMatchObject({
      requests: 1, promptTokens: 120, completionTokens: 30, totalTokens: 150,
      cachedPromptTokens: 80, reasoningTokens: 10,
    });
    expect(app.recordedEvents.filter((event) => event.type === "token-usage")).toHaveLength(1);
    handleUsage(app);
    const overlay = app.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind !== "pager") throw new Error("Usage pager did not open");
    expect(overlay.body).toContain(`River / ${model}`);
    expect(overlay.body).toContain("| 1 | 120 | 30 | 150 |");
    expect(overlay.body).not.toContain("No provider token usage");
  }, 30_000);

  it("updates current context while accumulating each follow-up exactly once", async () => {
    const app = start();
    expect(await app.session.submit(prompt)).toMatchObject({ status: "completed" });
    expect(await app.session.submit(prompt)).toMatchObject({ status: "completed" });
    expect(app.session.getState().contextUsage).toMatchObject({
      contextTokens: 240, lastCompletionTokens: 60, exact: true,
      sessionPromptTokens: 360, sessionCompletionTokens: 90,
    });
    expect(app.session.usageReport().totals).toMatchObject({
      requests: 2, promptTokens: 360, completionTokens: 90, totalTokens: 450,
      cachedPromptTokens: 240, reasoningTokens: 30,
    });
    expect(app.recordedEvents.filter((event) => event.type === "token-usage")).toHaveLength(2);
  }, 30_000);

  it("does not invent usage or overwrite measured context when telemetry is absent", async () => {
    const app = start();
    expect(await app.session.submit(prompt)).toMatchObject({ status: "completed" });
    reportUsage = false;
    expect(await app.session.submit(prompt)).toMatchObject({ status: "completed" });
    expect(app.session.getState().contextUsage).toMatchObject({ contextTokens: 120, lastCompletionTokens: 30, exact: true });
    expect(app.session.usageReport().totals).toMatchObject({ requests: 1, promptTokens: 120, completionTokens: 30, totalTokens: 150 });
    expect(app.recordedEvents.filter((event) => event.type === "token-usage")).toHaveLength(1);
  }, 30_000);
});
