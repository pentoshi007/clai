import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderId } from "../types.js";
import type { KiroUsageLimits } from "./kiro-auth.js";

export interface BalanceBreakdown {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly overages: number;
  readonly currency?: string | undefined;
}

export interface ProviderBalance {
  readonly provider: ProviderId;
  readonly plan?: string | undefined;
  readonly breakdowns: readonly BalanceBreakdown[];
  readonly overageStatus?: string | undefined;
  readonly nextResetAt?: number | undefined;
  readonly fetchedAt: number;
}

export type BalanceState = "idle" | "loading" | "ready" | "error";

export interface BalanceSnapshot {
  readonly state: BalanceState;
  readonly balance?: ProviderBalance | undefined;
}

const CACHE_DIR = join(homedir(), ".clai");
const CACHE_PATH = join(CACHE_DIR, "provider-balance.json");

export const PROVIDER_BALANCE_REFRESH_MS = 60_000;

type Listener = () => void;

const listeners = new Set<Listener>();
const states = new Map<ProviderId, BalanceSnapshot>();
const timers = new Map<ProviderId, ReturnType<typeof setInterval>>();

let cacheLoaded = false;

function loadCache(): void {
  if (cacheLoaded) return;
  cacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Record<string, ProviderBalance>;
    for (const [provider, balance] of Object.entries(raw)) {
      if (balance && Array.isArray(balance.breakdowns)) {
        states.set(provider as ProviderId, { state: "ready", balance });
      }
    }
  } catch {}
}

function persistCache(): void {
  try {
    const out: Record<string, ProviderBalance> = {};
    for (const [, snapshot] of states) {
      if (snapshot.balance) out[snapshot.balance.provider] = snapshot.balance;
    }
    if (Object.keys(out).length === 0) return;
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(out), "utf8");
  } catch {}
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function setState(provider: ProviderId, snapshot: BalanceSnapshot): void {
  states.set(provider, snapshot);
  notify();
}

export function subscribeProviderBalances(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getProviderBalanceSnapshot(provider: ProviderId): BalanceSnapshot {
  loadCache();
  return states.get(provider) ?? { state: "idle" };
}

export function kiroBalanceFromLimits(limits: KiroUsageLimits): ProviderBalance {
  const breakdowns: BalanceBreakdown[] = limits.breakdowns.map((b) => ({
    label: b.displayNamePlural ?? b.displayName ?? (b.resourceType ?? "usage").toLowerCase(),
    used: b.currentUsage,
    limit: b.usageLimit,
    overages: b.currentOverages,
    ...(b.currency ? { currency: b.currency } : {}),
  }));
  return {
    provider: "kiro",
    ...(limits.subscriptionTitle ? { plan: limits.subscriptionTitle } : {}),
    breakdowns,
    ...(limits.overageStatus ? { overageStatus: limits.overageStatus } : {}),
    ...(limits.nextDateReset && limits.nextDateReset > 0
      ? { nextResetAt: limits.nextDateReset * 1000 }
      : {}),
    fetchedAt: Date.now(),
  };
}

export function ensureProviderBalancePolling(
  provider: ProviderId,
  fetcher: () => Promise<ProviderBalance | undefined>,
  intervalMs = PROVIDER_BALANCE_REFRESH_MS,
): void {
  loadCache();
  if (timers.has(provider)) return;
  const existing = states.get(provider);
  if (!existing || existing.state === "idle") {
    setState(provider, { state: "loading", ...(existing?.balance ? { balance: existing.balance } : {}) });
  }
  const tick = async (): Promise<void> => {
    try {
      const balance = await fetcher();
      if (balance) {
        setState(provider, { state: "ready", balance });
        persistCache();
      } else {
        const prev = states.get(provider);
        setState(provider, { state: "error", ...(prev?.balance ? { balance: prev.balance } : {}) });
      }
    } catch {
      const prev = states.get(provider);
      setState(provider, { state: "error", ...(prev?.balance ? { balance: prev.balance } : {}) });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  timers.set(provider, timer);
}

export function stopProviderBalancePolling(): void {
  for (const timer of timers.values()) clearInterval(timer);
  timers.clear();
}

export function resetProviderBalancesForTesting(): void {
  stopProviderBalancePolling();
  states.clear();
  listeners.clear();
  cacheLoaded = false;
}
