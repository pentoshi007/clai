/**
 * `web.search` registry handler.
 *
 * Resolves the active {@link SearchProviderId}, looks up the API key (if
 * needed), dispatches a single outbound request via the registered
 * adapter, validates each returned hit per Requirement 7.3, truncates to
 * `maxResults`, and emits exactly one structured audit-log entry per
 * invocation (Requirement 5.5).
 *
 * Error handling mirrors the design's error matrix: timeouts (1.8),
 * missing keys (3.4), provider auth failures (6.1), rate limiting (6.2),
 * network failures (6.3), parse failures (6.5), 5xx (6.6), and other
 * non-2xx (1.9). Every failure surfaces as `ok=false` with a categorical
 * `error.kind` and a human-readable message that names the active
 * provider.
 *
 * Per Requirement 6.7 the handler issues exactly one outbound request
 * attempt — there is no retry on transient failure.
 *
 * The provider modules register themselves into the shared
 * {@link searchProviders} registry on import; we eagerly import them
 * here so `web.search` can be invoked without any lazy-load surprises.
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

  // Arm the 15-second invocation timeout (Requirement 1.8) and
  // propagate any caller-supplied AbortSignal so SIGINT etc. still
  // collapse the in-flight request.
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const controller = new AbortController();
  const onCallerAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onCallerAbort);
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Do not pin the event loop on the timeout.
  (timer as unknown as { unref?: () => void }).unref?.();

  // Dispatch (Requirement 6.7: exactly one attempt, no retry).
  let raw: RawProviderResponse;
  try {
    raw = await provider.search(
      trimmedQuery,
      maxResults,
      { ...(apiKey !== undefined ? { apiKey } : {}) },
      controller.signal,
    );
  } catch (err) {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener("abort", onCallerAbort);
    const outcome = controller.signal.aborted
      ? buildTimeoutOutcome(provider.id, timeoutMs)
      : buildNetworkOutcome(provider.id, err);
    void emitAudit(outcome, trimmedQuery.length);
    return errorResult(outcome);
  } finally {
    clearTimeout(timer);
    if (options.signal) options.signal.removeEventListener("abort", onCallerAbort);
  }

  // Map provider HTTP status to a categorical WebSearchErrorKind.
  const httpError = classifyHttpStatus(provider.id, raw);
  if (httpError) {
    const outcome: WebSearchOutcome = {
      ok: false,
      provider: provider.id,
      results: [],
      error: httpError,
    };
    void emitAudit(outcome, trimmedQuery.length);
    return errorResult(outcome);
  }

  // 2xx with parseError surfaces as a `parse` failure (Requirement 6.5).
  if (raw.parseError) {
    const outcome: WebSearchOutcome = {
      ok: false,
      provider: provider.id,
      results: [],
      error: {
        kind: "parse",
        provider: provider.id,
        message: `${provider.displayName}: response parse error (${raw.parseError})`,
      },
    };
    void emitAudit(outcome, trimmedQuery.length);
    return errorResult(outcome);
  }

  // Filter and validate hits per Requirement 7.3, then truncate.
  const filtered: SearchResult[] = [];
  for (const hit of raw.hits) {
    if (filtered.length >= maxResults) break;
    const normalised = normaliseHit(hit);
    if (!normalised) continue;
    filtered.push(normalised);
  }

  const outcome: WebSearchOutcome = {
    ok: true,
    provider: provider.id,
    results: filtered,
  };
  void emitAudit(outcome, trimmedQuery.length);
  return successResult(outcome);
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
  if (status >= 200 && status < 300) return undefined;
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
