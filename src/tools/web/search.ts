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
 * — Exa first, then Tavily, then Brave — whenever a key is configured for
 * it. Each
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
import { buildSearchAuditPayload } from "./audit.js";
import { searchProviders, type SearchProvider } from "./providers/provider.js";
// Importing the provider modules below ensures their side-effect
// registration into `searchProviders` runs before the handler is
// invoked. (DDG → keyless default; Exa / Brave / Tavily → optional.)
import "./providers/duckduckgo.js";
import "./providers/brave.js";
import "./providers/tavily.js";
import "./providers/exa.js";
import { DEFAULT_MAX_RESULTS, MAX_MAX_RESULTS, MAX_QUERY_LENGTH, MIN_MAX_RESULTS, MIN_QUERY_LENGTH, SEARCH_TIMEOUT_MS, type SearchProviderId, type WebSearchArgs, type WebSearchErrorKind, type WebSearchOutcome } from "./types.js";
import { SearchKeySet, attemptProviderWithKeyRotation } from "./search-attempts.js";

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
  // One deadline covers provider selection, the primary request, and every
  // cross-provider fallback. A failed attempt never receives a fresh budget.
  const timeoutMs = Math.max(1, options.timeoutMs ?? SEARCH_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const remainingMs = (): number => Math.max(0, deadline - Date.now());

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

  const primaryKeys = await resolveSearchKeySet(providerId, options.resolveKey);
  if (provider.needsApiKey && primaryKeys.keys.length === 0) {
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

  const auditAttempt = (outcome: WebSearchOutcome): void => {
    void emitAudit(outcome, trimmedQuery.length);
  };
  const primaryOutcome = await attemptProviderWithKeyRotation({
    provider,
    keys: primaryKeys,
    query: trimmedQuery,
    maxResults,
    timeoutMs,
    remainingMs,
    signal: options.signal,
    retrySameKey: options.providerOverride === undefined && options.resolveKey === undefined,
    onOutcome: auditAttempt,
  });
  if (primaryOutcome.ok) return successResult(primaryOutcome);
  if (primaryOutcome.error?.kind === "timeout" || remainingMs() <= 0) {
    return errorResult(primaryOutcome);
  }

  // DuckDuckGo is keyless and remains the default. When it fails, try a
  // configured keyed provider; each keyed provider applies the same circular
  // key rotation as a directly selected search provider.
  const fallbackAllowed = options.providerOverride === undefined;
  if (fallbackAllowed && provider.id === "duckduckgo") {
    const fallbackNotes: string[] = [];
    let anyKeyConfigured = false;
    for (const candidateId of DDG_FALLBACK_ORDER) {
      if (remainingMs() <= 0 || options.signal?.aborted) break;
      const candidate = searchProviders[candidateId];
      if (!candidate) continue;

      const candidateKeys = await resolveSearchKeySet(candidateId, options.resolveKey);
      if (candidateKeys.keys.length === 0) continue;
      anyKeyConfigured = true;

      const fallbackOutcome = await attemptProviderWithKeyRotation({
        provider: candidate,
        keys: candidateKeys,
        query: trimmedQuery,
        maxResults,
        timeoutMs,
        remainingMs,
        signal: options.signal,
        retrySameKey: options.providerOverride === undefined && options.resolveKey === undefined,
        onOutcome: auditAttempt,
      });
      if (fallbackOutcome.ok) return successResult(fallbackOutcome);
      fallbackNotes.push(
        `${candidate.displayName}: ${fallbackOutcome.error?.kind ?? "failed"}`,
      );
      if (fallbackOutcome.error?.kind === "timeout" || remainingMs() <= 0) break;
    }
    if (primaryOutcome.error) {
      if (fallbackNotes.length > 0) {
        primaryOutcome.error.message += ` Fallback also failed (${fallbackNotes.join("; ")}).`;
      } else if (!anyKeyConfigured) {
        primaryOutcome.error.message += ` No keyed fallback provider is configured; set one so web.search can recover automatically, e.g. \`clai search-provider exa\` then \`clai set exa <KEY>\` (Tavily and Brave also supported).`;
      }
    }
  }

  return errorResult(primaryOutcome);
}

// ---------------------------------------------------------------------------
// Per-provider attempt and API-key rotation
// ---------------------------------------------------------------------------

/** Ordered fallback after a keyless DuckDuckGo failure. */
const DDG_FALLBACK_ORDER: readonly SearchProviderId[] = ["exa", "tavily", "brave"];

async function resolveSearchKeySet(
  id: SearchProviderId,
  resolveKey: WebSearchOptions["resolveKey"],
): Promise<SearchKeySet> {
  if (resolveKey) {
    const value = await resolveKey(id);
    return {
      keys: value ? [{ value }] : [],
      activeIndex: 0,
      source: "injected",
    };
  }
  const { getSearchProviderKeys } = await import("../../store/keys.js");
  return getSearchProviderKeys(id);
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

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

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
  // Compact human listing for the model + UI card. Pretty-printed JSON made
  // tool cards show "··· N lines more ···" and the generic reducer then
  // dropped the middle hits — models misread that as "search interrupted".
  const n = outcome.results.length;
  const lines: string[] = [
    `web.search complete · ${outcome.provider} · ${n} result${n === 1 ? "" : "s"}`,
    `Status: complete (all ${n} hits listed below; not truncated or interrupted).`,
    "",
  ];
  for (let i = 0; i < n; i++) {
    const hit = outcome.results[i]!;
    lines.push(`${i + 1}. ${hit.title}`);
    lines.push(`   ${hit.url}`);
    if (hit.snippet.trim()) {
      const snip = hit.snippet.replace(/\s+/g, " ").trim();
      lines.push(
        `   ${snip.length > 320 ? `${snip.slice(0, 317)}…` : snip}`,
      );
    }
    lines.push("");
  }
  // Single-line JSON appendix for tests/tooling (not pretty-printed).
  lines.push(JSON.stringify({ results: outcome.results }));
  return {
    ok: true,
    output: lines.join("\n"),
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
