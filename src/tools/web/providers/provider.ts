
import {
  searchProviderIds,
  type SearchProviderId,
} from "../types.js";

export interface SearchProvider {
  id: SearchProviderId;
  displayName: string;
  needsApiKey: boolean;
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

export interface RawProviderResponse {
  status: number;
  hits: Array<{ title?: string; url?: string; snippet?: string }>;
  parseError?: string;
}

export const searchProviders = {} as Record<SearchProviderId, SearchProvider>;

export function assertSearchProvider(value: string): SearchProviderId {
  const normalized = value.trim().toLowerCase();
  if ((searchProviderIds as readonly string[]).includes(normalized)) {
    return normalized as SearchProviderId;
  }
  throw new Error(
    `Unsupported search provider "${value}". Supported providers: ${searchProviderIds.join(", ")}`,
  );
}
