import { describe, expect, it } from "vitest";
import {
  SessionUsageLedger,
  usageCacheHitRate,
} from "../src/app/controllers/session-usage-ledger.js";
import { formatSessionUsage } from "../src/ui-core/rendering/format-usage.js";
import type { TokenUsage } from "../src/llm/token-usage.js";

function usage(partial: Partial<TokenUsage> = {}): TokenUsage {
  return {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
    exact: true,
    ...partial,
  };
}

describe("SessionUsageLedger accumulation", () => {
  it("starts empty and reports nothing", () => {
    const ledger = new SessionUsageLedger();
    expect(ledger.isEmpty()).toBe(true);
    expect(ledger.report().routes).toEqual([]);
    expect(ledger.report().totals.requests).toBe(0);
    expect(ledger.persist()).toBeUndefined();
  });

  it("sums repeat requests on the same provider/model route", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage(), "openai", "gpt-5.4-mini");
    ledger.record(usage({ promptTokens: 50, completionTokens: 5, totalTokens: 55 }), "openai", "gpt-5.4-mini");
    const report = ledger.report();
    expect(report.routes).toHaveLength(1);
    expect(report.routes[0]).toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      requests: 2,
      promptTokens: 150,
      completionTokens: 25,
      totalTokens: 175,
    });
    expect(report.totals).toMatchObject({ routes: 1, requests: 2, totalTokens: 175 });
  });

  it("keys routes by provider and model together", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage(), "openai", "gpt-5.4-mini");
    ledger.record(usage(), "openai", "gpt-5.4");
    ledger.record(usage(), "gemini", "gpt-5.4-mini");
    expect(ledger.report().routes).toHaveLength(3);
    expect(ledger.report().totals.routes).toBe(3);
  });

  it("orders routes by total tokens descending, insertion order on ties", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage({ totalTokens: 10 }), "openai", "small");
    ledger.record(usage({ totalTokens: 900 }), "openai", "big");
    ledger.record(usage({ totalTokens: 10 }), "openai", "small-two");
    expect(ledger.report().routes.map((r) => r.model)).toEqual(["big", "small", "small-two"]);
  });

  it("normalizes unknown providers, blank models, and negative counts", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage({ promptTokens: -5, completionTokens: -1, totalTokens: -9 }), undefined, "   ");
    const route = ledger.report().routes[0]!;
    expect(route.provider).toBeUndefined();
    expect(route.model).toBeUndefined();
    expect(route.promptTokens).toBe(0);
    expect(route.completionTokens).toBe(0);
    expect(route.totalTokens).toBe(0);
  });

  it("clears on reset", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage(), "openai", "gpt-5.4-mini");
    ledger.clear();
    expect(ledger.isEmpty()).toBe(true);
    expect(ledger.report().totals.requests).toBe(0);
  });
});

describe("cache semantics: absent means unknown, never zero", () => {
  it("leaves cache fields undefined when no provider reported them", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage(), "ollama", "llama3.1:8b");
    const route = ledger.report().routes[0]!;
    expect(route.cachedPromptTokens).toBeUndefined();
    expect(route.cacheCreationTokens).toBeUndefined();
    expect(route.uncachedPromptTokens).toBeUndefined();
    expect(route.reasoningTokens).toBeUndefined();
    expect(usageCacheHitRate(route)).toBeUndefined();
  });

  it("keeps a reported zero distinct from unknown", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage({ cachedPromptTokens: 0 }), "openai", "gpt-5.4-mini");
    const route = ledger.report().routes[0]!;
    expect(route.cachedPromptTokens).toBe(0);
    expect(usageCacheHitRate(route)).toBe(0);
  });

  it("excludes non-reporting requests from the hit-rate denominator", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage({ promptTokens: 1_000, cachedPromptTokens: 900 }), "anthropic", "claude");
    ledger.record(usage({ promptTokens: 1_000 }), "anthropic", "claude");
    const route = ledger.report().routes[0]!;
    expect(route.promptTokens).toBe(2_000);
    expect(route.cachedPromptTokens).toBe(900);
    expect(route.cacheBasePromptTokens).toBe(1_000);
    expect(usageCacheHitRate(route)).toBeCloseTo(0.9, 10);
  });

  it("never reports a hit rate above 100%", () => {
    expect(usageCacheHitRate({ cachedPromptTokens: 500, cacheBasePromptTokens: 100 })).toBe(1);
  });

  it("returns undefined when the denominator is unusable", () => {
    expect(usageCacheHitRate({ cachedPromptTokens: 5, cacheBasePromptTokens: 0 })).toBeUndefined();
    expect(usageCacheHitRate({ cachedPromptTokens: undefined, cacheBasePromptTokens: 10 })).toBeUndefined();
  });

  it("skips unmeasured prompt requests in the cache denominator and counts them", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(
      usage({ promptTokens: 800, promptTokensKnown: false, cachedPromptTokens: 400 }),
      "fireworks",
      "kimi",
    );
    const route = ledger.report().routes[0]!;
    expect(route.promptTokens).toBe(0);
    expect(route.unmeasuredPromptRequests).toBe(1);
    expect(route.cacheBasePromptTokens).toBeUndefined();
    expect(usageCacheHitRate(route)).toBeUndefined();
  });

  it("counts estimated requests separately from exact ones", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage({ exact: false }), "free", "free-1/x");
    ledger.record(usage(), "free", "free-1/x");
    expect(ledger.report().routes[0]!.estimatedRequests).toBe(1);
    expect(ledger.report().totals.estimatedRequests).toBe(1);
  });
});

describe("totals roll up route values", () => {
  it("keeps totals undefined when no route reported caching", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage(), "ollama", "a");
    ledger.record(usage(), "ollama", "b");
    expect(ledger.report().totals.cachedPromptTokens).toBeUndefined();
    expect(usageCacheHitRate(ledger.report().totals)).toBeUndefined();
  });

  it("aggregates only the reporting routes into the total rate", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage({ promptTokens: 1_000, cachedPromptTokens: 750 }), "anthropic", "claude");
    ledger.record(usage({ promptTokens: 4_000 }), "ollama", "llama3.1:8b");
    const totals = ledger.report().totals;
    expect(totals.promptTokens).toBe(5_000);
    expect(totals.cachedPromptTokens).toBe(750);
    expect(totals.cacheBasePromptTokens).toBe(1_000);
    expect(usageCacheHitRate(totals)).toBeCloseTo(0.75, 10);
  });
});

describe("persist / restore round trip", () => {
  it("restores every route field", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(
      usage({
        promptTokens: 1_000,
        completionTokens: 120,
        totalTokens: 1_120,
        cachedPromptTokens: 800,
        cacheCreationTokens: 64,
        uncachedPromptTokens: 200,
        reasoningTokens: 40,
      }),
      "anthropic",
      "claude-opus-4-7",
    );
    ledger.record(usage({ exact: false }), "free", "free-1/x");

    const restored = new SessionUsageLedger();
    restored.restore(JSON.parse(JSON.stringify(ledger.persist())));
    expect(restored.report()).toEqual(ledger.report());
  });

  it("keeps accumulating after a restore", () => {
    const first = new SessionUsageLedger();
    first.record(usage(), "openai", "gpt-5.4-mini");
    const second = new SessionUsageLedger();
    second.restore(first.persist());
    second.record(usage(), "openai", "gpt-5.4-mini");
    expect(second.report().routes[0]!.requests).toBe(2);
    expect(second.report().totals.totalTokens).toBe(240);
  });

  it("ignores untrusted, malformed, or duplicate persisted rows", () => {
    const ledger = new SessionUsageLedger();
    ledger.restore("not-an-array");
    expect(ledger.isEmpty()).toBe(true);
    ledger.restore([
      null,
      "nope",
      { requests: 0, promptTokens: 0, completionTokens: 0 },
      { provider: "not-a-provider", model: "m", requests: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      { provider: "openai", model: "m", requests: 1, promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      { provider: "openai", model: "m", requests: 9, promptTokens: 90, completionTokens: 9, totalTokens: 99 },
    ]);
    const report = ledger.report();
    expect(report.routes).toHaveLength(2);
    expect(report.routes.find((r) => r.provider === undefined)?.model).toBe("m");
    expect(report.routes.filter((r) => r.provider === "openai")).toHaveLength(1);
    expect(report.routes.find((r) => r.provider === "openai")?.requests).toBe(1);
  });

  it("backfills a missing total from input plus output", () => {
    const ledger = new SessionUsageLedger();
    ledger.restore([{ provider: "openai", model: "m", requests: 1, promptTokens: 10, completionTokens: 2, totalTokens: 0 }]);
    expect(ledger.report().routes[0]!.totalTokens).toBe(12);
  });

  it("caps the number of persisted routes", () => {
    const ledger = new SessionUsageLedger();
    for (let i = 0; i < 200; i += 1) ledger.record(usage(), "openai", `model-${i}`);
    expect(ledger.persist()!.length).toBe(64);
    const restored = new SessionUsageLedger();
    restored.restore(ledger.persist());
    expect(restored.report().routes).toHaveLength(64);
  });

  it("replaces prior contents on restore rather than merging", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage(), "openai", "stale");
    ledger.restore([{ provider: "gemini", model: "fresh", requests: 1, promptTokens: 1, completionTokens: 1, totalTokens: 2 }]);
    expect(ledger.report().routes.map((r) => r.model)).toEqual(["fresh"]);
  });
});

describe("formatSessionUsage markdown", () => {
  it("explains an empty session instead of printing an empty table", () => {
    const body = formatSessionUsage(new SessionUsageLedger().report(), { sessionId: "sess-1" });
    expect(body).toContain("# Session usage");
    expect(body).toContain("No provider token usage");
    expect(body).not.toContain("|");
  });

  it("renders a markdown table with right-aligned numbers and a bold total last", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage({ promptTokens: 32_704, completionTokens: 1_312, totalTokens: 34_016, cachedPromptTokens: 28_928 }), "anthropic", "claude-opus-4-7");
    ledger.record(usage({ promptTokens: 640, completionTokens: 96, totalTokens: 736 }), "ollama", "llama3.1:8b");
    const body = formatSessionUsage(ledger.report(), { sessionId: "sess-1", title: "audit" });
    const lines = body.split("\n");

    expect(lines[0]).toBe("# Session usage");
    expect(body).toContain("| PROVIDER / MODEL | REQ | IN | OUT | TOTAL | CACHED | RATE |");
    expect(body).toContain("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    expect(body).toContain("| `anthropic / claude-opus-4-7` | 1 | 32,704 | 1,312 | 34,016 | 28,928 | 88.5% |");
    expect(body).toContain("| `ollama / llama3.1:8b` | 1 | 640 | 96 | 736 | — | — |");

    const tableRows = lines.filter((line) => line.startsWith("|"));
    expect(tableRows[tableRows.length - 1]).toBe(
      "| **TOTAL · 2 routes** | **2** | **33,344** | **1,408** | **34,752** | **28,928** | **88.5%** |",
    );
  });

  it("uses an em dash for values the provider never reported", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage(), "ollama", "llama3.1:8b");
    const body = formatSessionUsage(ledger.report(), { sessionId: "sess-1" });
    expect(body).toContain("| `ollama / llama3.1:8b` | 1 | 100 | 20 | 120 | — | — |");
    expect(body).not.toContain("0.0%");
  });

  it("lists provider-specific telemetry only when it exists", () => {
    const bare = new SessionUsageLedger();
    bare.record(usage(), "ollama", "llama3.1:8b");
    expect(formatSessionUsage(bare.report(), { sessionId: "s" })).not.toContain("Additional provider telemetry");

    const rich = new SessionUsageLedger();
    rich.record(usage({ cacheCreationTokens: 512, reasoningTokens: 64, exact: false }), "anthropic", "claude");
    const body = formatSessionUsage(rich.report(), { sessionId: "s" });
    expect(body).toContain("### Additional provider telemetry");
    expect(body).toContain("cache write 512");
    expect(body).toContain("reasoning 64");
    expect(body).toContain("1 estimated request");
  });

  it("escapes pipes so a model id cannot break the table", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage(), "openai", "weird|model");
    const body = formatSessionUsage(ledger.report(), { sessionId: "sess|1" });
    expect(body).toContain("weird\\|model");
    expect(body).toContain("sess\\|1");
    for (const row of body.split("\n").filter((line) => line.startsWith("|"))) {
      expect(row.replace(/\\\|/g, "").split("|")).toHaveLength(9);
    }
  });

  it("marks a tiny but non-zero cache rate instead of rounding it to zero", () => {
    const ledger = new SessionUsageLedger();
    ledger.record(usage({ promptTokens: 1_000_000, cachedPromptTokens: 1 }), "openai", "gpt-5.4-mini");
    expect(formatSessionUsage(ledger.report(), { sessionId: "s" })).toContain("<0.1%");
  });
});
