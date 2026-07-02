/**
 * `web.search` registry handler: resolves the active
 * {@link SearchProviderId}, looks up its API key, dispatches a single
 * outbound request per provider (no retry of the *same* provider),
 * validates/truncates the hits to `maxResults`, and emits one audit-log
 * entry per attempt. Failures surface as `ok=false` with a categorical
 * `error.kind` naming the provider.
 *
 * DuckDuckGo fallback: DuckDuckGo is the keyless default and regularly
 * returns anti-bot challenges (HTTP 202) or upstream 502/5xx responses on
 * shared or rate-limited networks. When the active provider is DuckDuckGo
 * and it fails, the handler transparently falls back to a keyed provider
 * — Tavily first, then Brave — whenever a key is configured for it. Each
 * fallback is a single attempt against a *different* provider, so the
 * per-provider single-attempt contract (Requirement 6.7) is preserved.
 *
 * Provider modules self-register into {@link searchProviders} on import,
 * so they're eagerly imported here.
 */

import type { ToolResult } from "../../types.js";
import { auditLog } from "../../store/logs.js";
import type { ToolRunOptions } from "../registry.js";
import { getActiveSearchProvider } from "../../store/config.js";
import { getSearchProviderKey } from "../../store/keys.js";
import { buildSearchAuditPayload } from "./audit.js";
import {
  searchProviders,
  type RawProviderResponse,
  type SearchProvider,
} from "./providers/provider.js";
// Importing the provider modules below ensures their side-effect
// registration into `searchProviders` runs before the handler is
// invoked. (DDG → keyless default; Brave / Tavily → optional.)
import "./providers/duckduckgo.js";
import "./providers/brave.js";
import "./providers/tavily.js";
import {
  DEFAULT_MAX_RESULTS,
  MAX_MAX_RESULTS,
  MAX_QUERY_LENGTH,
  MAX_SNIPPET_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_MAX_RESULTS,
  MIN_QUERY_LENGTH,
  SEARCH_TIMEOUT_MS,
  type SearchProviderId,
  type SearchResult,
  type WebSearchArgs,
  type WebSearchError,
  type WebSearchErrorKind,
  type WebSearchOutcome,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Optional injection points for tests so the search dispatch can be
 * exercised without invoking the real provider modules. Production
 * callers never pass these.
 */
export interface WebSearchOptions extends ToolRunOptions {
  /** Override the active provider lookup. */
  provider?: SearchProviderId;
  /** Override the registered {@link SearchProvider} for the active id. */
  providerOverride?: SearchProvider;
  /** Override the API-key resolver. Returns the raw key (or undefined). */
  resolveKey?: (id: SearchProviderId) => Promise<string | undefined>;
  /** Wall-clock timeout in milliseconds. Default: {@link SEARCH_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/**
 * Run `web.search`. Always emits a single audit-log entry. Never
 * throws — every failure mode surfaces as `ok=false`.
 */
export async function webSearch(
  args: WebSearchArgs,
  options: WebSearchOptions = {},
): Promise<ToolResult> {
  // Validate args before resolving the provider so a malformed call
  // never appears in the audit log under a real provider's id.
  const validated = validateArgs(args);
  if (!validated.ok) {
    const provider = options.provider ?? safeProvider();
    const outcome: WebSearchOutcome = {
      ok: false,
      provider,
      results: [],
      error: {
        kind: "validation",
        provider,
        message: validated.message,
      },
    };
    void emitAudit(outcome, validated.queryLength);
    return errorResult(outcome);
  }

  const trimmedQuery = validated.query;
  const maxResults = validated.maxResults;

  // Resolve the active provider (Requirement 3.5: defaults to
  // DuckDuckGo when no key configured).
  const providerId = options.provider ?? safeProvider();
  const provider =
    options.providerOverride ?? searchProviders[providerId];
  if (!provider) {
    const outcome: WebSearchOutcome = {
      ok: false,
      provider: providerId,
      results: [],
      error: {
        kind: "validation",
        provider: providerId,
        message: `Unknown search provider "${providerId}". Set a supported provider via \`clai search-provider <id>\`.`,
      },
    };
    void emitAudit(outcome, trimmedQuery.length);
    return errorResult(outcome);
  }

  // Resolve API key (env > keychain > fallback file).
  let apiKey: string | undefined;
  if (provider.needsApiKey) {
    apiKey = await (options.resolveKey
      ? options.resolveKey(providerId)
      : (await getSearchProviderKey(providerId)).value);
    if (!apiKey || apiKey.length === 0) {
      const outcome: WebSearchOutcome = {
        ok: false,
        provider: providerId,
        results: [],
        error: {
          kind: "missing-key",
          provider: providerId,
          message: `${provider.displayName} requires an API key. Run \`clai set ${providerId} <KEY>\`.`,
        },
      };
      void emitAudit(outcome, trimmedQuery.length);
      return errorResult(outcome);
    }
  }

  // Resolve the per-invocation timeout (Requirement 1.8).
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;

  // Primary attempt against the active provider. Per Requirement 6.7
  // this is exactly one outbound request with no retry of the *same*
  // provider.
  const primaryOutcome = await attemptProvider(
    provider,
    apiKey,
    trimmedQuery,
    maxResults,
    timeoutMs,
    options.signal,
  );
  void emitAudit(primaryOutcome, trimmedQuery.length);
  if (primaryOutcome.ok) return successResult(primaryOutcome);

  // DuckDuckGo is the keyless default and is prone to anti-bot
  // challenges (HTTP 202) and upstream 502/5xx responses on shared or
  // rate-limited networks. When DDG fails and a keyed provider is
  // configured, transparently fall back to it — Tavily first, then
  // Brave — so the agent still receives results instead of a hard
  // failure. Each fallback is a single attempt against a *different*
  // provider, so the per-provider single-attempt invariant is kept.
  //
  // Fallback is skipped when the caller injected a `providerOverride`
  // (unit tests and explicit single-provider dispatch), preserving the
  // single-attempt behavior those paths assert on.
  const fallbackAllowed = options.providerOverride === undefined;
  if (fallbackAllowed && provider.id === "duckduckgo") {
    const fallbackNotes: string[] = [];
    let anyKeyConfigured = false;
    for (const candidateId of DDG_FALLBACK_ORDER) {
      const candidate = searchProviders[candidateId];
      if (!candidate) continue;

      const candidateKey = options.resolveKey
        ? await options.resolveKey(candidateId)
        : (await getSearchProviderKey(candidateId)).value;
      // No key configured for this candidate → skip silently and try
      // the next one.
      if (!candidateKey || candidateKey.length === 0) continue;
      anyKeyConfigured = true;

      const fbOutcome = await attemptProvider(
        candidate,
        candidateKey,
        trimmedQuery,
        maxResults,
        timeoutMs,
        options.signal,
      );
      void emitAudit(fbOutcome, trimmedQuery.length);
      if (fbOutcome.ok) return successResult(fbOutcome);
      fallbackNotes.push(
        `${candidate.displayName}: ${fbOutcome.error?.kind ?? "failed"}`,
      );
    }
    if (primaryOutcome.error) {
      if (fallbackNotes.length > 0) {
        // Every configured fallback also failed — keep DuckDuckGo's
        // error as the primary signal but note the fallback attempts.
        primaryOutcome.error.message += ` Fallback also failed (${fallbackNotes.join("; ")}).`;
      } else if (!anyKeyConfigured) {
        // DDG failed and no keyed provider is configured to fall back
        // to. Make the failure actionable (the user's network is
        // likely anti-bot-challenging or rate-limiting DuckDuckGo).
        primaryOutcome.error.message += ` No keyed fallback provider is configured; set one so web.search can recover automatically, e.g. \`clai search-provider tavily\` then \`clai set tavily <KEY>\` (Brave also supported).`;
      }
    }
  }

  return errorResult(primaryOutcome);
}

// ---------------------------------------------------------------------------
// Per-provider attempt
// ---------------------------------------------------------------------------

/**
 * Ordered list of keyed providers `web.search` falls back to when the
 * keyless DuckDuckGo default fails. Tavily is preferred over Brave per
 * the operator request; a provider is only attempted when a key is
 * actually configured for it.
 */
const DDG_FALLBACK_ORDER: readonly SearchProviderId[] = ["tavily", "brave"];

/**
 * Dispatch a single search request against one provider, arming the
 * per-invocation timeout and propagating any caller-supplied
 * `AbortSignal`. Never throws — every failure mode is mapped to a
 * `WebSearchOutcome` with `ok=false` and a categorical `error.kind`.
 *
 * This is the unit of "exactly one outbound request" (Requirement 6.7);
 * cross-provider fallback in {@link webSearch} composes multiple
 * single-attempt calls against *different* providers.
 */
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
  // Do not pin the event loop on the timeout.
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

  // Map provider HTTP status to a categorical WebSearchErrorKind.
  const httpError = classifyHttpStatus(provider.id, raw);
  if (httpError) {
    return {
      ok: false,
      provider: provider.id,
      results: [],
      error: httpError,
    };
  }

  // 2xx with parseError surfaces as a `parse` failure (Requirement 6.5).
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

  // Filter and validate hits per Requirement 7.3, then truncate.
  const filtered: SearchResult[] = [];
  for (const hit of raw.hits) {
    if (filtered.length >= maxResults) break;
    const normalised = normaliseHit(hit);
    if (!normalised) continue;
    filtered.push(normalised);
  }

  return {
    ok: true,
    provider: provider.id,
    results: filtered,
  };
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

interface ValidArgs {
  ok: true;
  query: string;
  maxResults: number;
  queryLength: number;
}

interface InvalidArgs {
  ok: false;
  message: string;
  queryLength: number;
}

/**
 * Synchronous validation of {@link WebSearchArgs} per Requirements 1.1,
 * 1.2, 1.5, 1.6. Returns the trimmed query and a concrete `maxResults`
 * value so downstream code does not need to re-derive defaults.
 */
function validateArgs(args: WebSearchArgs): ValidArgs | InvalidArgs {
  const rawQuery = args?.query;
  if (typeof rawQuery !== "string") {
    return {
      ok: false,
      message: "query must be a string",
      queryLength: 0,
    };
  }
  const trimmed = rawQuery.trim();
  const len = trimmed.length;
  if (len < MIN_QUERY_LENGTH || len > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      message: `query length must be between ${MIN_QUERY_LENGTH} and ${MAX_QUERY_LENGTH} characters after trimming (got ${len})`,
      queryLength: len,
    };
  }

  let maxResults = DEFAULT_MAX_RESULTS;
  if (args.maxResults !== undefined) {
    if (
      typeof args.maxResults !== "number" ||
      !Number.isInteger(args.maxResults) ||
      args.maxResults < MIN_MAX_RESULTS ||
      args.maxResults > MAX_MAX_RESULTS
    ) {
      return {
        ok: false,
        message: `maxResults must be an integer in [${MIN_MAX_RESULTS}, ${MAX_MAX_RESULTS}]`,
        queryLength: len,
      };
    }
    maxResults = args.maxResults;
  }

  return { ok: true, query: trimmed, maxResults, queryLength: len };
}

// ---------------------------------------------------------------------------
// Hit normalisation (Requirement 7.3)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Map provider HTTP status codes to a {@link WebSearchErrorKind} per the
 * design's error matrix. Returns `undefined` when the status is in the
 * 2xx range so the caller can move on to body classification.
 */
function classifyHttpStatus(
  id: SearchProviderId,
  raw: RawProviderResponse,
): WebSearchError | undefined {
  const provider = searchProviders[id];
  const displayName = provider?.displayName ?? id;
  const { status } = raw;
  // Only a plain 200 carries a real results page. Other 2xx codes —
  // notably the HTTP 202 anti-bot challenge that DuckDuckGo's
  // html/lite endpoints now return — are NOT results pages. Treating
  // them as success made the handler parse zero hits and report the
  // misleading literal "No results found.", which in turn made the
  // agent loop. Surface them as an actionable error instead.
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

// ---------------------------------------------------------------------------
// Audit + ToolResult
// ---------------------------------------------------------------------------

async function emitAudit(
  outcome: WebSearchOutcome,
  queryLength: number,
): Promise<void> {
  try {
    await auditLog(
      "tool.web_search",
      buildSearchAuditPayload(outcome, queryLength),
    );
  } catch {
    // never let audit failures bubble up
  }
}

/**
 * Best-effort active-provider lookup that never throws even when the
 * config store is mid-migration or unreadable. Falls back to
 * `"duckduckgo"` so a fresh install still works keylessly per
 * Requirement 3.5.
 */
function safeProvider(): SearchProviderId {
  try {
    return getActiveSearchProvider();
  } catch {
    return "duckduckgo";
  }
}

/**
 * Compose a successful {@link ToolResult}. The output starts with a one
 * line summary so the agent sees the result count and provider before
 * the JSON, then includes the structured `{results: [...]}` block.
 */
function successResult(outcome: WebSearchOutcome): ToolResult {
  if (outcome.results.length === 0) {
    // Requirement 1.7 / 7.4: literal "No results found." string.
    return {
      ok: true,
      output: "No results found.",
      exitCode: 0,
    };
  }
  const summary = `${outcome.provider}: ${outcome.results.length} result${outcome.results.length === 1 ? "" : "s"}`;
  const json = JSON.stringify({ results: outcome.results }, null, 2);
  return {
    ok: true,
    output: `${summary}\n\n${json}`,
    exitCode: 0,
  };
}

function errorResult(outcome: WebSearchOutcome): ToolResult {
  const head = outcome.error?.message ?? "web.search failed";
  const json = JSON.stringify(
    {
      error: outcome.error,
      provider: outcome.provider,
    },
    null,
    2,
  );
  return {
    ok: false,
    output: `${head}\n\n${json}`,
    exitCode: 1,
  };
}

// Re-export for convenience to match the symmetric `webFetch` shape.
export type { WebSearchOutcome, WebSearchErrorKind };
