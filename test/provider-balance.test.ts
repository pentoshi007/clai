import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureProviderBalancePolling,
  getProviderBalanceSnapshot,
  kiroBalanceFromLimits,
  resetProviderBalancesForTesting,
  subscribeProviderBalances,
} from "../src/llm/provider-balance.js";
import { formatProviderBalanceSection } from "../src/ui-core/commands/session-commands.js";

function limits(used: number, limit = 50) {
  return {
    subscriptionTitle: "KIRO FREE",
    nextDateReset: 1790812800,
    breakdowns: [
      {
        resourceType: "CREDIT",
        displayNamePlural: "Credits",
        currentUsage: used,
        usageLimit: limit,
        currentOverages: 0,
      },
    ],
  };
}

describe("provider balance tracker", () => {
  afterEach(() => {
    resetProviderBalancesForTesting();
  });

  it("converts kiro usage limits into a balance snapshot", () => {
    const balance = kiroBalanceFromLimits(limits(12.5));
    expect(balance.provider).toBe("kiro");
    expect(balance.plan).toBe("KIRO FREE");
    expect(balance.breakdowns[0]).toMatchObject({ label: "Credits", used: 12.5, limit: 50 });
    expect(balance.fetchedAt).toBeGreaterThan(0);
  });

  it("polls repeatedly and keeps the balance present across reads", async () => {
    vi.useFakeTimers();
    let fetchCount = 0;
    ensureProviderBalancePolling(
      "kiro",
      async () => {
        fetchCount += 1;
        return kiroBalanceFromLimits(limits(fetchCount));
      },
      1000,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(getProviderBalanceSnapshot("kiro").state).toBe("ready");
    const first = getProviderBalanceSnapshot("kiro").balance;
    expect(first?.breakdowns[0]?.used).toBe(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchCount).toBeGreaterThanOrEqual(4);
    const later = getProviderBalanceSnapshot("kiro").balance;
    expect(later?.breakdowns[0]?.used).toBe(fetchCount);
    expect(getProviderBalanceSnapshot("kiro").state).toBe("ready");
    vi.useRealTimers();
  });

  it("keeps showing the last known balance when a refresh fails", async () => {
    vi.useFakeTimers();
    let calls = 0;
    ensureProviderBalancePolling(
      "kiro",
      async () => {
        calls += 1;
        if (calls > 1) throw new Error("network down");
        return kiroBalanceFromLimits(limits(7));
      },
      1000,
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    const snapshot = getProviderBalanceSnapshot("kiro");
    expect(snapshot.state).toBe("error");
    expect(snapshot.balance?.breakdowns[0]?.used).toBe(7);
    const rendered = formatProviderBalanceSection("Kiro AI", snapshot);
    expect(rendered).toContain("Kiro AI balance");
    expect(rendered).toContain("7 / 50");
    expect(rendered).toContain("43 remaining");
    expect(rendered).toContain("stale");
    vi.useRealTimers();
  });

  it("notifies subscribers on each refresh", async () => {
    vi.useFakeTimers();
    let notified = 0;
    const unsubscribe = subscribeProviderBalances(() => {
      notified += 1;
    });
    ensureProviderBalancePolling("kiro", async () => kiroBalanceFromLimits(limits(1)), 1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(notified).toBeGreaterThanOrEqual(3);
    unsubscribe();
    vi.useRealTimers();
  });

  it("formats a loading and idle state without a balance", () => {
    expect(formatProviderBalanceSection("Kiro AI", { state: "loading" })).toContain("fetching live balance");
    expect(formatProviderBalanceSection("Kiro AI", { state: "idle" })).not.toContain("remaining");
  });

  it("shows the balance section only when kiro is the active provider", async () => {
    const { handleUsage } = await import("../src/ui-core/commands/session-commands.js");
    const { kiroBalanceFromLimits } = await import("../src/llm/provider-balance.js");

    const openedBodies: string[] = [];
    const makeServices = (provider: string) => ({
      session: {
        getState: () => ({ sessionId: "s", provider, title: undefined }),
        usageReport: () => ({
          routes: [],
          totals: { routes: 0, requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, apis: [], charges: [] },
        }),
        subscribe: () => () => {},
        notifyExternalUpdate: () => {},
        notice: () => {},
      },
      overlay: {
        openPager: (_title: string, body: string) => {
          openedBodies.push(body);
          return true;
        },
      },
    });

    ensureProviderBalancePolling("kiro", async () =>
      kiroBalanceFromLimits(limits(3)),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(getProviderBalanceSnapshot("kiro").state).toBe("ready");

    handleUsage(makeServices("anthropic") as never);
    handleUsage(makeServices("kiro") as never);

    expect(openedBodies).toHaveLength(2);
    expect(openedBodies[0]).not.toContain("Kiro AI balance");
    expect(openedBodies[1]).toContain("Kiro AI balance");
    expect(openedBodies[1]).toContain("3 / 50");
  });
});
