/**
 * Search-provider adapter interface and registry stub.
 *
 * Concrete provider implementations (Brave, Tavily, DuckDuckGo) live next to
 * this file and register themselves into {@link searchProviders}. The registry
 * starts empty; it is populated by the per-provider modules so a missing
 * import surfaces immediately as a `Cannot read property 'search'` style error
 * rather than as a silently wrong dispatch.
 *
 * Shapes here match the design document's "Provider adapter interface"
 * section verbatim.
 */

import {
  searchProviderIds,
  type SearchProviderId,
} from "../types.js";

/**
 * Adapter implemented by every search-provider module.
 *
 * The `search` method is called by `web.search` after argument validation and
 * provider/key resolution. Implementations must:
 *
 * - Issue exactly one outbound HTTP request (no retry on transient failure;
 *   Requirement 6.7).
 * - Honor the provided {@link AbortSignal} for the 15-second invocation
 *   timeout (Requirement 1.8).
 * - Return a {@link RawProviderResponse} describing the HTTP outcome and the
 *   raw, unfiltered hit list. Shape validation, URL filtering, and
 *   `maxResults` truncation are performed by the `web.search` handler, not by
 *   the adapter.
 */
export interface SearchProvider {
  /** Stable identifier matching one of {@link SearchProviderId}. */
  id: SearchProviderId;
  /** Human-friendly name shown in CLI listings. */
  displayName: string;
  /** Whether the adapter requires an API key to dispatch a request. */
  needsApiKey: boolean;
  /**
   * Environment variable the key store consults first when resolving this
   * provider's API key (e.g. `"BRAVE_SEARCH_API_KEY"`). Omitted for keyless
   * providers.
   */
  envVar?: string;
  /**
   * Dispatch a single search request.
   *
   * @param query      Already-trimmed query string; length ∈ [1, 400].
   * @param maxResults Already-clamped result count; ∈ [1, 20].
   * @param auth       Resolved credentials. `apiKey` is present iff
   *                   {@link needsApiKey} is true and a key was found.
   * @param signal     Abort signal wired to the 15-second invocation timer.
   */
  search(
    query: string,
    maxResults: number,
    auth: { apiKey?: string },
    signal: AbortSignal,
  ): Promise<RawProviderResponse>;
}

/**
 * Provider-agnostic view of a single dispatch's outcome.
 *
 * Adapters surface raw HTTP status + hit array here so the `web.search`
 * handler can map status codes to {@link import("../types.js").WebSearchErrorKind}
 * uniformly across providers (Requirements 6.1, 6.2, 6.5, 6.6, 1.9).
 */
export interface RawProviderResponse {
  /** HTTP status code returned by the provider's endpoint. */
  status: number;
  /**
   * Hit list extracted from the provider response. Fields are optional
   * because validation/filtering happens in the handler — the adapter is
   * permitted to forward whatever the provider produced.
   */
  hits: Array<{ title?: string; url?: string; snippet?: string }>;
  /**
   * Populated when the provider returned a 2xx status but the body did not
   * match the adapter's expected shape; surfaces as
   * {@link import("../types.js").WebSearchErrorKind} `"parse"` (Requirement 6.5).
   */
  parseError?: string;
}

/**
 * Registry of installed search-provider adapters, keyed by
 * {@link SearchProviderId}.
 *
 * Starts empty. Concrete adapters in `./brave.ts`, `./tavily.ts`, and
 * `./duckduckgo.ts` populate this object on module import; the
 * `web.search` handler resolves the active provider through it.
 */
export const searchProviders = {} as Record<SearchProviderId, SearchProvider>;

/**
 * Validate that an arbitrary string is one of the supported
 * {@link SearchProviderId} values, returning the narrowed type.
 *
 * Mirrors `assertProvider` in `src/llm/provider.ts` so CLI surfaces such as
 * `clai set <provider>` and `clai search-provider <id>` get the same error
 * shape regardless of which keyspace the id belongs to (Requirement 3.7).
 */
export function assertSearchProvider(value: string): SearchProviderId {
  const normalized = value.trim().toLowerCase();
  if ((searchProviderIds as readonly string[]).includes(normalized)) {
    return normalized as SearchProviderId;
  }
  throw new Error(
    `Unsupported search provider "${value}". Supported providers: ${searchProviderIds.join(", ")}`,
  );
}
