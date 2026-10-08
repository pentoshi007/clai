import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCompositionRoot, type AppServices } from "../../src/ui-core/bootstrap/composition-root.js";
import { handleUsage } from "../../src/ui-core/commands/session-commands.js";

vi.mock("../../src/llm/qoder/qoder-signer.js", () => ({
  QoderSigner: {
    create: async () => ({
      prepare: () => ({ url: "https://test.invalid/model/list", headers: {} }),
      prepareInfer: ({ body }: { body: string }) => ({ url: "https://test.invalid/inference", headers: {}, body }),
      free: () => {},
    }),
  },
}));

const credential = JSON.stringify({
  uid: "fixture", accessToken: "fixture", expireTime: 4_000_000_000, encryptUserInfo: "fixture",
  key: "fixture", machineId: "fixture", machineToken: "fixture",
});
let services: AppServices | undefined;

function frame(body: object | string): string {
  return `data: ${JSON.stringify({ body: typeof body === "string" ? body : JSON.stringify(body), statusCodeValue: 200 })}\n\n`;
}

beforeEach(() => {
  vi.stubEnv("QODER_API_KEY", credential);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/model/list")) return Response.json({ chat: [{ key: "qfmodel", is_free: true, max_input_tokens: 180_000 }] });
    if (url.endsWith("/inference")) return new Response(
      frame({ choices: [{ delta: { content: "QODER_USAGE_OK" }, finish_reason: "stop" }] }) +
      frame({ choices: [], usage: {
        prompt_tokens: 81, completion_tokens: 192, total_tokens: 273,
        prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 182 },
      } }) + frame("[DONE]"),
      { headers: { "content-type": "text/event-stream" } },
    );
    throw new Error(`Unexpected integration request: ${url}`);
  }));
});
afterEach(() => {
  services?.dispose();
  services = undefined;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function start(): AppServices {
  services = createCompositionRoot({
    provider: "qoder", model: "qfmodel:free", mode: "ask", noHistory: true, captureEvents: true,
    persistence: { async saveSession() {}, async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {} },
  });
  return services;
}

describe("Qoder usage through the production session", () => {
  it("updates /usage and the context chip from a trailing provider usage frame", async () => {
    const app = start();
    expect((await app.session.submit("Reply with exactly QODER_USAGE_OK. Do not call tools.")).status).toBe("completed");
    expect(app.session.usageReport().totals).toMatchObject({
      requests: 1, promptTokens: 81, completionTokens: 192, totalTokens: 273,
      cachedPromptTokens: 20, reasoningTokens: 182,
    });
    const state = app.session.getState();
    expect(state.contextUsage).toMatchObject({ contextTokens: 81, lastCompletionTokens: 192, exact: true });
    expect(state.contextChip).toMatch(/81/);
    expect(app.recordedEvents.filter((event) => event.type === "token-usage")).toHaveLength(1);
    handleUsage(app);
    const overlay = app.overlay.getState();
    expect(overlay.kind).toBe("pager");
    if (overlay.kind !== "pager") throw new Error("Usage pager did not open");
    expect(overlay.body).toContain("qfmodel:free");
    expect(overlay.body).toContain("81");
    expect(overlay.body).toContain("192");
    expect(overlay.body).not.toContain("No provider token usage");
  }, 30_000);

  it("counts each response once across follow-up turns", async () => {
    const app = start();
    await app.session.submit("Reply with exactly QODER_USAGE_OK. Do not call tools.");
    await app.session.submit("Reply with exactly QODER_USAGE_OK again. Do not call tools.");
    expect(app.session.usageReport().totals).toMatchObject({ requests: 2, promptTokens: 162, completionTokens: 384, totalTokens: 546 });
    expect(app.session.getState().contextUsage).toMatchObject({ contextTokens: 81, lastCompletionTokens: 192, exact: true });
  }, 30_000);
});
