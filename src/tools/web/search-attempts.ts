import { searchProviders } from "./providers/provider.js";
import type { RawProviderResponse, SearchProvider } from "./providers/provider.js";
import { MAX_SNIPPET_LENGTH, MAX_TITLE_LENGTH } from "./types.js";
import type { SearchProviderId, SearchResult, WebSearchError, WebSearchOutcome } from "./types.js";

const MAX_SEARCH_RETRIES = 6;

const MAX_SEARCH_RETRY_WAIT_MS = 120_000;

export interface SearchKeySet {
  readonly keys: readonly { value: string }[];
  readonly activeIndex: number;
  readonly source: string;
}

function searchKeyAttemptPlan(keyCount: number, activeIndex: number): number[] {
  if (keyCount <= 0) return [];
  const start = ((activeIndex % keyCount) + keyCount) % keyCount;
  return Array.from({ length: keyCount }, (_, offset) => (start + offset) % keyCount);
}

function searchAttemptsPerKey(keyCount: number): number {
  return keyCount <= 1 ? MAX_SEARCH_RETRIES + 1 : 2;
}

function shouldStopSearchKeyCircle(outcome: WebSearchOutcome): boolean {
  const status = outcome.error?.status;
  return status === 404 || status === 422;
}

function shouldSwitchSearchKeyImmediately(outcome: WebSearchOutcome): boolean {
  return outcome.error?.kind === "auth" || outcome.error?.status === 402;
}

function isRetriableSearchKeyFailure(outcome: WebSearchOutcome): boolean {
  return ["rate-limit", "network", "server"].includes(outcome.error?.kind ?? "");
}

function searchRetryWaitMs(outcome: WebSearchOutcome, attempt: number): number {
  return outcome.error?.kind === "rate-limit"
    ? Math.pow(3, attempt) * 2_000
    : Math.pow(2, attempt) * 1_000;
}

async function waitForSearchRetry(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function attemptProviderWithKeyRotation(opts: {
  provider: SearchProvider;
  keys: SearchKeySet;
  query: string;
  maxResults: number;
  timeoutMs: number;
  remainingMs: () => number;
  signal?: AbortSignal | undefined;
  retrySameKey: boolean;
  onOutcome: (outcome: WebSearchOutcome) => void;
}): Promise<WebSearchOutcome> {
  const { provider, keys } = opts;
  const keyCount = keys.keys.length;
  const plan = provider.needsApiKey
    ? searchKeyAttemptPlan(keyCount, keys.activeIndex)
    : [0];
  let lastOutcome: WebSearchOutcome | undefined;

  for (const keyIndex of plan) {
    const apiKey = provider.needsApiKey ? keys.keys[keyIndex]?.value : undefined;
    const attempts =
      opts.retrySameKey && provider.needsApiKey ? searchAttemptsPerKey(keyCount) : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const budgetMs = opts.remainingMs();
      if (budgetMs <= 0 || opts.signal?.aborted) {
        return buildTimeoutOutcome(provider.id, opts.timeoutMs);
      }
      const outcome = await attemptProvider(
        provider,
        apiKey,
        opts.query,
        opts.maxResults,
        budgetMs,
        opts.signal,
      );
      opts.onOutcome(outcome);
      if (outcome.ok) {
        if (provider.needsApiKey && keys.source !== "env" && keys.source !== "injected") {
          const { markSearchProviderKeySuccess } = await import("../../store/keys.js");
          void markSearchProviderKeySuccess(provider.id, keyIndex).catch(() => {});
        }
        return outcome;
      }
      lastOutcome = outcome;
      if (outcome.error?.kind === "timeout" || shouldStopSearchKeyCircle(outcome)) {
        return outcome;
      }
      if (shouldSwitchSearchKeyImmediately(outcome)) break;
      if (!isRetriableSearchKeyFailure(outcome)) return outcome;
      if (!opts.retrySameKey || attempt + 1 >= attempts) break;

      const wait = searchRetryWaitMs(outcome, attempt);
      if (wait > MAX_SEARCH_RETRY_WAIT_MS || wait >= opts.remainingMs()) {
        break;
      }
      try {
        await waitForSearchRetry(wait, opts.signal);
      } catch {
        return buildTimeoutOutcome(provider.id, opts.timeoutMs);
      }
    }
  }

  return lastOutcome ?? buildTimeoutOutcome(provider.id, opts.timeoutMs);
}

async function attemptProvider(
  provider: SearchProvider,
  apiKey: string | undefined,
  query: string,
  maxResults: number,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
): Promise<WebSearchOutcome> {
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort);
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as unknown as { unref?: () => void }).unref?.();

  let raw: RawProviderResponse;
  try {
    raw = await provider.search(
      query,
      maxResults,
      { ...(apiKey !== undefined ? { apiKey } : {}) },
      controller.signal,
    );
  } catch (err) {
    return controller.signal.aborted
      ? buildTimeoutOutcome(provider.id, timeoutMs)
      : buildNetworkOutcome(provider.id, err);
  } finally {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }

  const httpError = classifyHttpStatus(provider.id, raw);
  if (httpError) {
    return {
      ok: false,
      provider: provider.id,
      results: [],
      error: httpError,
    };
  }

  if (raw.parseError) {
    return {
      ok: false,
      provider: provider.id,
      results: [],
      error: {
        kind: "parse",
        provider: provider.id,
        message: `${provider.displayName}: response parse error (${raw.parseError})`,
      },
    };
  }

  const filtered: SearchResult[] = [];
  for (const hit of raw.hits) {
    const normalised = normaliseHit(hit);
    if (!normalised) continue;
    filtered.push(normalised);
  }
  filtered.sort(
    (a, b) => trustHostScore(b.url) - trustHostScore(a.url),
  );
  const truncated = filtered.slice(0, maxResults);

  return {
    ok: true,
    provider: provider.id,
    results: truncated,
  };
}

function trustHostScore(url: string): number {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (
      host.endsWith(".gov") ||
      host.endsWith(".gov.uk") ||
      host.endsWith(".gov.au") ||
      host.endsWith(".europa.eu") ||
      host === "wikipedia.org" ||
      host.endsWith(".wikipedia.org")
    ) {
      return 3;
    }
    if (
      host === "bbc.co.uk" ||
      host.endsWith(".bbc.co.uk") ||
      host === "bbc.com" ||
      host.endsWith(".bbc.com") ||
      host === "reuters.com" ||
      host.endsWith(".reuters.com") ||
      host === "apnews.com" ||
      host.endsWith(".apnews.com") ||
      host === "theguardian.com" ||
      host.endsWith(".theguardian.com") ||
      host === "nytimes.com" ||
      host.endsWith(".nytimes.com") ||
      host.endsWith(".who.int") ||
      host.endsWith(".un.org")
    ) {
      return 2;
    }
    if (
      host === "github.com" ||
      host.endsWith(".github.io") ||
      host.endsWith(".mozilla.org") ||
      host.endsWith(".microsoft.com") ||
      host.endsWith(".apple.com") ||
      host.endsWith(".google.com") ||
      host.endsWith(".cloudflare.com")
    ) {
      return 1;
    }
  } catch {
  }
  return 0;
}

const URL_INVALID_CHARS_RE = /[\s\u0000-\u001f\u007f]/;

function normaliseHit(
  hit: { title?: string; url?: string; snippet?: string },
): SearchResult | undefined {
  const url = typeof hit.url === "string" ? hit.url : "";
  if (url.length === 0) return undefined;
  if (URL_INVALID_CHARS_RE.test(url)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }

  const title = typeof hit.title === "string" ? hit.title.trim() : "";
  if (title.length === 0) return undefined;
  const clampedTitle = title.slice(0, MAX_TITLE_LENGTH);

  const snippet = typeof hit.snippet === "string" ? hit.snippet : "";
  const clampedSnippet = snippet.slice(0, MAX_SNIPPET_LENGTH);

  return {
    title: clampedTitle,
    url,
    snippet: clampedSnippet,
  };
}

function classifyHttpStatus(
  id: SearchProviderId,
  raw: RawProviderResponse,
): WebSearchError | undefined {
  const provider = searchProviders[id];
  const displayName = provider?.displayName ?? id;
  const { status } = raw;
  if (status === 200) return undefined;
  if (status > 200 && status < 300) {
    return {
      kind: "http",
      provider: id,
      status,
      message: `${displayName}: received HTTP ${status} instead of a results page (typically an anti-bot challenge). Configure a keyed provider with \`clai search-provider brave\` (or \`tavily\`) and \`clai set <provider> <KEY>\`.`,
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: "auth",
      provider: id,
      status,
      message: `${displayName} authentication failed (HTTP ${status}). Run \`clai set ${id}\` to update the key.`,
    };
  }
  if (status === 429) {
    return {
      kind: "rate-limit",
      provider: id,
      status,
      message: `${displayName} rate-limited (HTTP 429). Retry later.`,
    };
  }
  if (status >= 500 && status < 600) {
    return {
      kind: "server",
      provider: id,
      status,
      message: `${displayName} server error (HTTP ${status}).`,
    };
  }
  if (status === 0) {
    return {
      kind: "network",
      provider: id,
      message: `${displayName}: provider returned no response (status=0).`,
    };
  }
  return {
    kind: "http",
    provider: id,
    status,
    message: `${displayName}: HTTP ${status}.`,
  };
}

function buildTimeoutOutcome(
  id: SearchProviderId,
  timeoutMs: number,
): WebSearchOutcome {
  const display = searchProviders[id]?.displayName ?? id;
  return {
    ok: false,
    provider: id,
    results: [],
    error: {
      kind: "timeout",
      provider: id,
      message: `${display}: timeout after ${Math.round(timeoutMs / 1000)}s`,
    },
  };
}

function buildNetworkOutcome(
  id: SearchProviderId,
  err: unknown,
): WebSearchOutcome {
  const display = searchProviders[id]?.displayName ?? id;
  const detail = err instanceof Error ? err.message : String(err);
  return {
    ok: false,
    provider: id,
    results: [],
    error: {
      kind: "network",
      provider: id,
      message: `${display}: network failure (${detail})`,
    },
  };
}
