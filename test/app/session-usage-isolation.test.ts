import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { SessionUsageLedger, usageCacheHitRate } from "../../src/app/controllers/session-usage-ledger.js";
import { formatSessionUsage } from "../../src/ui-core/rendering/format-usage.js";
import { renderExitSummary } from "../../src/ui-core/rendering/exit-summary.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { currentSessionAffinity } from "../../src/llm/session-affinity.js";
import type { OperationUsageSnapshot } from "../../src/llm/operation-usage.js";
import type { completeWithProvider, streamWithProvider } from "../../src/llm/router.js";
import type { TokenUsage } from "../../src/types.js";

const mocks = vi.hoisted(() => ({
  naming: vi.fn<typeof completeWithProvider>(),
  stream: vi.fn<typeof streamWithProvider>(),
}));

vi.mock("../../src/llm/router.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/llm/router.js")>(),
  completeWithProvider: mocks.naming,
  streamWithProvider: mocks.stream,
}));

const sessions: SessionController[] = [];
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected live provider call"); }));
});
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function usage(cachedPromptTokens: number, cacheCreationTokens = 0): TokenUsage {
  return { promptTokens: 100, completionTokens: 20, totalTokens: 120, exact: true, cachedPromptTokens, cacheCreationTokens };
}

function operation(cached: number, outcome: "success" | "failure" = "success"): OperationUsageSnapshot {
  return {
    attempts: [{ provider: "codex", model: "gpt-5.4", mode: "stream", reason: "initial", sequence: 1, outcome, usage: { kind: "known", value: usage(cached, 10) } }],
    aggregate: { status: "known", knownAdmissions: 1, unknownAdmissions: 0, usage: usage(cached, 10) },
  };
}

function session() {
  const value = new SessionController({
    sessionId: `usage-isolation-${sessions.length}`,
    provider: "codex",
    model: "gpt-5.4",
    emit: () => undefined,
    agent: { async runTurn() { return createTurnOutcome({ status: "succeeded", answer: "done", steps: 0, remainingCriteria: [] }); } },
    persistence: {
      async saveSession() {},
      async loadPlan() { return undefined; },
      async savePlan() {},
      async deletePlan() {},
    },
  });
  sessions.push(value);
  return value;
}

const assignment = { cwd: process.cwd(), provider: "codex" as const, model: "gpt-5.4" };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("session usage attribution", () => {
  it("excludes real naming operations without disabling generated titles", async () => {
    mocks.naming.mockImplementation(async (_request, options) => {
      expect(currentSessionAffinity()).toBe("usage-isolation-0:auxiliary");
      options?.onOperationUsage?.(operation(75));
      return { text: "SUMMARY: fix usage\nTITLE: Usage attribution", provider: "free", model: "naming-model" };
    });
    const value = session();
    value.loadHistory([{ role: "user", content: "Fix usage" }, { role: "assistant", content: "Working" }]);
    value.recordTokenUsage(usage(40), "gpt-5.4", "codex");
    const before = value.usageReport();
    await value.submit("First follow-up");
    await value.submit("Second follow-up");
    await flush();
    await flush();
    expect(mocks.naming).toHaveBeenCalledOnce();
    expect(value.getState().title).toBe("Usage attribution");
    expect(value.usageReport()).toEqual(before);
  });

  it("attributes identical-model siblings and failed requests separately from main", async () => {
    mocks.stream.mockImplementation(async (request, _onToken, options) => {
      const first = request.messages.some((message) => message.content.includes("Inspect first surface"));
      options?.onOperationUsage?.(operation(first ? 80 : 20));
      if (first) options?.onOperationUsage?.(operation(0, "failure"));
      return {
        text: "Status: complete\n## Findings\nScoped evidence collected from the implementation\n## Evidence\nsrc/app/controllers/session-controller.ts:615 routes usage correctly\n## Next steps\nNo additional work required\n## Coverage gaps\nProvider transport is mocked; no live calls",
        provider: "codex", model: "gpt-5.4", finishReason: "stop",
      };
    });
    const value = session();
    value.recordTokenUsage(usage(40), "gpt-5.4", "codex");
    const first = value.subagents.start({ ...assignment, title: "First", prompt: "Inspect first surface" });
    const second = value.subagents.start({ ...assignment, title: "Second", prompt: "Inspect second surface" });
    await Promise.all([value.subagents.wait(first.id), value.subagents.wait(second.id)]);
    const report = value.usageReport();
    expect(report.routes, JSON.stringify({ report, runs: value.subagents.list() })).toHaveLength(3);
    expect(report.totals.requests).toBe(4);
    const main = report.routes.find((route) => !route.source)!;
    const one = report.routes.find((route) => route.source?.id === first.id)!;
    const two = report.routes.find((route) => route.source?.id === second.id)!;
    expect(usageCacheHitRate(main)).toBe(0.4);
    expect(usageCacheHitRate(one)).toBe(0.4);
    expect(usageCacheHitRate(two)).toBe(0.2);
    expect(one.source?.number).not.toBe(two.source?.number);
    const body = formatSessionUsage(report, { sessionId: value.getState().sessionId });
    expect(body).toMatch(/subagent-1 · [^\n]+ \/ gpt-5\.4/);
    expect(body).toMatch(/subagent-2 · [^\n]+ \/ gpt-5\.4/);
    expect(body).toContain("each subagent separately");
    expect(body).toContain("cache write 20");
    const exit = renderExitSummary({ usage: report, sessionId: "usage-test", messages: 2, cwd: process.cwd(), durationMs: 1, resumable: true, width: 180, color: false, unicode: true });
    expect(exit).toContain("subagent-1");
    expect(exit).toContain("subagent-2");
    expect(value.getState().provider).toBe("codex");
    expect(value.getState().model).toBe("gpt-5.4");
    await value.subagents.restart(first.id);
    await value.subagents.wait(first.id);
    const restarted = value.usageReport().routes.find((route) => route.source?.id === first.id)!;
    expect(restarted.source).toEqual(one.source);
    expect(restarted.requests).toBe(4);
  });
});

describe("persisted subagent usage identities", () => {
  it("keeps labels and cache rates across restore and model rotation", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage(40), "codex", "gpt-5.4");
    ledger.record(usage(80), "codex", "gpt-5.4", "responses", "child-one");
    ledger.record(usage(20), "codex", "gpt-5.4", "responses", "child-two");
    const restored = new SessionUsageLedger();
    restored.restore(JSON.parse(JSON.stringify(ledger.persist())));
    expect(restored.report()).toEqual(ledger.report());
    restored.record(usage(50), "openai", "different-model", "responses", "child-one");
    restored.record(usage(0), "codex", "gpt-5.4", "responses", "child-three");
    const report = restored.report();
    expect(report.routes.filter((route) => route.source?.id === "child-one").map((route) => route.source?.number)).toEqual([1, 1]);
    expect(report.routes.find((route) => route.source?.id === "child-three")?.source?.number).toBe(3);
    expect(usageCacheHitRate(report.routes.find((route) => route.source?.id === "child-two")!)).toBe(0.2);
    restored.clear();
    restored.record(usage(0), "codex", "gpt-5.4", undefined, "fresh-child");
    expect(restored.report().routes[0]?.source?.number).toBe(1);
  });

  it("restores legacy main rows and ignores malformed sources instead of merging them", () => {
    const ledger = new SessionUsageLedger();
    const row = { provider: "codex", model: "gpt-5.4", requests: 1, ...usage(40) };
    ledger.restore([
      row,
      { ...row, source: { kind: "subagent", id: "bad\nlabel", number: 1 } },
      { ...row, source: { kind: "subagent", id: "child", number: -1 } },
      { ...row, source: { kind: "subagent", id: "one", number: 1 } },
      { ...row, source: { kind: "subagent", id: "two", number: 1 } },
    ]);
    expect(ledger.report().routes).toHaveLength(3);
    expect(ledger.report().routes.map((route) => route.source?.number)).toEqual([undefined, 1, 2]);
  });
});
