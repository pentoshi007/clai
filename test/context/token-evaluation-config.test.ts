import { describe, expect, it } from "vitest";
import { parseEvaluationConfig, counterbalancedVariants } from "../../scripts/token-evaluation-config.js";
import { EvaluationObserver } from "../../scripts/token-evaluation-observer.js";

const config = { version: 1, routes: [{ provider: "openai", model: "fixed-model", toolCalling: "native", thinking: { enabled: false, effort: "medium" } }], fixtures: ["search-edit"], repeats: 3, maxCalls: 100, scratchRoot: "/scratch/session" };
describe("explicit isolated evaluation configuration", () => {
  it("pins route/settings, explicit budget and counterbalanced trial order", () => {
    expect(parseEvaluationConfig(config, ["search-edit"])).toEqual(config);
    for (const provider of ["nvidia", "openai", "anthropic", "gemini"]) {
      expect(parseEvaluationConfig({ ...config, routes: [{ ...config.routes[0], provider }] }, ["search-edit"]).routes[0]?.provider).toBe(provider);
    }
    expect(() => parseEvaluationConfig({ ...config, routes: [{ ...config.routes[0], provider: "ollama" }] }, ["search-edit"])).toThrow(/unimplemented/);
    expect(counterbalancedVariants(1)).toEqual(["before", "after"]);
    expect(counterbalancedVariants(2)).toEqual(["after", "before"]);
    expect(() => parseEvaluationConfig({ ...config, maxCalls: 0 }, ["search-edit"])).toThrow(/maxCalls/);
    expect(() => parseEvaluationConfig({ ...config, apiKey: "synthetic" }, ["search-edit"])).toThrow(/credential/);
    expect(() => parseEvaluationConfig({ ...config, scratchRoot: "." }, ["search-edit"])).toThrow(/absolute/);
    expect(() => parseEvaluationConfig({ ...config, fixtures: ["unknown"] }, ["search-edit"])).toThrow(/fixture/);
    expect(() => parseEvaluationConfig({ ...config, routes: [{ ...config.routes[0], apiKey: "synthetic" }] }, ["search-edit"])).toThrow(/credential/);
  });

  it("forwards each attempt lifecycle once and retains failed/auxiliary usage separately", () => {
    const observer = new EvaluationObserver();
    let completions = 0;
    observer.noteRequest({ messages: [], purpose: "compaction" });
    const handle = observer.begin({ provider: "openai", model: "fixed-model", mode: "stream", reason: "retry" }, {
      begin: () => ({ complete: () => { completions += 1; } }),
    });
    handle.complete("failure");
    handle.complete("success");
    expect(completions).toBe(1);
    expect(observer.attempts).toMatchObject([{ purpose: "auxiliary", outcome: "failure", usage: null }]);
    expect(observer.auxiliaryInvocations).toBe(1);
    observer.noteRequest({ messages: [], purpose: "turn" });
    expect(observer.primaryInvocations).toBe(1);
  });

  it("counts failed admissions, enforces budget before dispatch and never stores request bodies", async () => {
    const observer = new EvaluationObserver();
    let calls = 0;
    const options = { maxCalls: 1, fingerprint: () => undefined, fetch: async () => { calls += 1; return new Response("synthetic", { status: 500 }); } };
    expect((await observer.fetch("https://api.example.test/v1/chat/completions", { body: '{"private":"synthetic"}' }, options)).status).toBe(500);
    await expect(observer.fetch("https://api.example.test/v1/chat/completions", undefined, options)).rejects.toThrow(/budget exhausted/);
    expect(calls).toBe(1);
    expect(observer.wires).toMatchObject([{ ordinal: 1, statusCode: 500, fingerprint: null }]);
    expect(JSON.stringify(observer)).not.toContain("private");
  });
});
