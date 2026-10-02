import type { ProviderAuth } from "./provider.js";
import { CODEX_API_BASE_URL, codexRequestHeaders } from "./codex-auth.js";
import { withCodexCredential } from "./codex-credential.js";
import { readJson } from "./http.js";
import type { BalanceBreakdown, ProviderBalance } from "./provider-balance.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numeric(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  const result = Number(value);
  return Number.isFinite(result) && result >= 0 ? result : undefined;
}

function windowLabel(seconds: number | undefined, fallback: string): string {
  if (!seconds) return fallback;
  if (seconds % 86_400 === 0) return seconds === 604_800 ? "Weekly" : `${seconds / 86_400} day`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour`;
  if (seconds % 60 === 0) return `${seconds / 60} minute`;
  return `${seconds} second`;
}

export function codexBalanceFromUsage(payload: unknown, accountId?: string): ProviderBalance {
  const usage = record(payload);
  if (!usage) throw new Error("Invalid ChatGPT usage response");
  const breakdowns: BalanceBreakdown[] = [];
  const addWindows = (value: unknown, prefix = ""): void => {
    const limits = record(value);
    for (const [name, fallback] of [["primary_window", "Primary"], ["secondary_window", "Secondary"]] as const) {
      const window = record(limits?.[name]);
      const used = numeric(window?.used_percent);
      if (used === undefined) continue;
      const resetAt = numeric(window?.reset_at);
      const resetAfter = numeric(window?.reset_after_seconds);
      breakdowns.push({
        label: `${prefix}${windowLabel(numeric(window?.limit_window_seconds), fallback)} limit`,
        used: Math.min(100, used),
        limit: 100,
        overages: 0,
        unit: "percent",
        nextResetAt: resetAt ? resetAt * 1000 : resetAfter !== undefined ? Date.now() + resetAfter * 1000 : undefined,
      });
    }
  };
  addWindows(usage.rate_limit);
  addWindows(usage.code_review_rate_limit, "Code review · ");
  if (Array.isArray(usage.additional_rate_limits)) {
    for (const value of usage.additional_rate_limits) {
      const additional = record(value);
      const label = additional?.limit_name ?? additional?.metered_feature;
      addWindows(additional?.rate_limit, typeof label === "string" ? `${label} · ` : "");
    }
  }
  const credits = record(usage.credits);
  const creditBalance = numeric(credits?.balance);
  const individual = record(record(usage.spend_control)?.individual_limit);
  const limit = numeric(individual?.limit);
  const used = numeric(individual?.used);
  if (limit !== undefined && used !== undefined) {
    const reset = numeric(individual?.reset_at);
    breakdowns.push({ label: "Spend limit", limit, used, overages: 0, nextResetAt: reset ? reset * 1000 : undefined });
  }
  if (!breakdowns.length && !credits && typeof usage.plan_type !== "string") throw new Error("ChatGPT usage response contains no subscription details");
  return {
    provider: "codex",
    accountId,
    plan: typeof usage.plan_type === "string" ? usage.plan_type : undefined,
    breakdowns,
    credits: credits ? {
      remaining: creditBalance,
      unlimited: credits.unlimited === true,
      available: credits.has_credits === true,
    } : undefined,
    limitReached: record(usage.rate_limit)?.limit_reached === true || record(usage.spend_control)?.reached === true,
    fetchedAt: Date.now(),
  };
}

export async function fetchCodexUsage(auth: ProviderAuth): Promise<ProviderBalance> {
  return withCodexCredential(auth, async (credential) => {
    const response = await fetch(`${CODEX_API_BASE_URL.replace(/\/codex$/, "")}/wham/usage`, {
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        ...codexRequestHeaders(credential.accountId, {}, credential.residency),
      },
      signal: AbortSignal.timeout(15_000),
    });
    return codexBalanceFromUsage(await readJson<unknown>(response), credential.accountId);
  });
}
