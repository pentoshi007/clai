

export type SearchProviderId = "brave" | "tavily" | "duckduckgo" | "exa";

export const searchProviderIds: readonly SearchProviderId[] = [
  "brave",
  "tavily",
  "duckduckgo",
  "exa",
] as const;

export type ExaSearchType =
  | "instant"
  | "fast"
  | "auto"
  | "deep-lite"
  | "deep"
  | "deep-reasoning";

export const exaSearchTypes: readonly ExaSearchType[] = [
  "instant",
  "fast",
  "auto",
  "deep-lite",
  "deep",
  "deep-reasoning",
] as const;

export const DEFAULT_EXA_SEARCH_TYPE: ExaSearchType = "deep-lite";

export const exaSearchTypeDescriptions: Record<ExaSearchType, string> = {
  instant: "~250 ms · quick lookups, autocomplete",
  fast: "~450 ms · low latency, good relevance",
  auto: "~1 s · balanced relevance and speed",
  "deep-lite": "~4 s · cheaper deep synthesis (default)",
  deep: "4-15 s · thorough research and enrichment",
  "deep-reasoning": "12-40 s · hardest multi-step synthesis",
};

export function asExaSearchType(value: string): ExaSearchType | undefined {
  const normalized = value.trim().toLowerCase();
  return (exaSearchTypes as readonly string[]).includes(normalized)
    ? (normalized as ExaSearchType)
    : undefined;
}

export interface WebSearchArgs {
  query: string;
  maxResults?: number;
}

export const DEFAULT_MAX_RESULTS = 5;

export const MIN_MAX_RESULTS = 1;

export const MAX_MAX_RESULTS = 20;

export const MIN_QUERY_LENGTH = 1;

export const MAX_QUERY_LENGTH = 400;

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const MIN_TITLE_LENGTH = 1;

export const MAX_TITLE_LENGTH = 512;

export const MIN_SNIPPET_LENGTH = 0;

export const MAX_SNIPPET_LENGTH = 2048;

export type WebSearchErrorKind =
  | "auth"
  | "rate-limit"
  | "network"
  | "parse"
  | "server"
  | "http"
  | "timeout"
  | "missing-key"
  | "validation";

export interface WebSearchError {
  kind: WebSearchErrorKind;
  provider: SearchProviderId;
  status?: number;
  message: string;
}

export interface WebSearchOutcome {
  ok: boolean;
  provider: SearchProviderId;
  results: SearchResult[];
  error?: WebSearchError;
}


export type ResponseMode = "readable" | "raw";

export type ResponsePart = "full" | "headers" | "body";

export const RESPONSE_MODES: readonly ResponseMode[] = [
  "readable",
  "raw",
] as const;

/**
 * Arguments accepted by the `web.fetch` tool.
 *
 * Defaults applied when an optional argument is omitted:
 * - `maxBytes`             → {@link DEFAULT_MAX_BYTES}        (Requirement 2.2)
 * - `includeHeaders`       → `false`
 * - `includeTls`           → `false`
 * - `includeTiming`        → `false`
 * - `includeRedirectChain` → `false`
 * - `responseMode`         → `"readable"`                     (Requirement 2.19)
 * - `redactSensitive`      → `true`                           (Requirement 2.20)
 */
export interface WebFetchArgs {
  url: string;
  maxBytes?: number;
  timeoutMs?: number;
  includeHeaders?: boolean;
  includeTls?: boolean;
  includeTiming?: boolean;
  includeRedirectChain?: boolean;
  responseMode?: ResponseMode;
  responsePart?: ResponsePart;
  topLines?: number;
  bottomLines?: number;
  maxOutputBytes?: number;
  redactSensitive?: boolean;
}

export const DEFAULT_MAX_BYTES = 262_144;

export const MIN_MAX_BYTES = 1024;

export const MAX_MAX_BYTES = 1_048_576;

export const DEFAULT_INCLUDE_HEADERS = false;

export const DEFAULT_INCLUDE_TIMING = false;

export const DEFAULT_INCLUDE_REDIRECT_CHAIN = false;

export const DEFAULT_RESPONSE_MODE: ResponseMode = "readable";

/** Default value applied when `WebFetchArgs.redactSensitive` is omitted. */
export const DEFAULT_REDACT_SENSITIVE = true;

export const MAX_REDIRECT_HOPS = 5;

export const MAX_COOKIES_CAPTURED = 32;

export const MAX_HEADER_VALUE_LENGTH = 4096;

export const TRUNCATION_MARKER = "[...truncated]";

/** Literal placeholder used wherever sensitive values are redacted. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

export const METADATA_BUDGET_BYTES = 65_536;

export const HTTP_ERROR_BODY_PREVIEW_BYTES = 4096;

export const FETCH_TIMEOUT_MS = 40_000;
export const MIN_FETCH_TIMEOUT_MS = 1_000;
export const MAX_FETCH_TIMEOUT_MS = 1_800_000;

export const SEARCH_TIMEOUT_MS = 40_000;

export type HeaderMap = Record<string, string>;

export interface TlsInfo {
  protocol: string;
  cipher: string;
  subjectCN: string;
  issuerCN: string;
  subjectAltNames: string[];
  notBefore: string;
  notAfter: string;
  fingerprintSha256: string;
}

export interface RedirectHop {
  url: string;
  status: number;
  location?: string;
}

export type RedirectChain = RedirectHop[];

export interface TimingInfo {
  dnsMs: number;
  tcpMs: number;
  tlsMs?: number;
  ttfbMs: number;
  totalMs: number;
}

export type CookieSameSite = "Strict" | "Lax" | "None";

/**
 * Public-attribute view of a cookie observed in a `Set-Cookie` header during
 * the fetch. Cookie values are replaced with {@link REDACTED_PLACEHOLDER}
 * when `redactSensitive=true` (Requirement 2.32).
 */
export interface CookieInfo {
  name: string;
  /** Raw cookie value; equals {@link REDACTED_PLACEHOLDER} when redacted. */
  value: string;
  domain?: string;
  path?: string;
  expires?: string;
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: CookieSameSite;
}

export interface WebFetchMetadata {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  resolvedIp: string;
  finalHostname: string;
  mode: ResponseMode;
  bytesReceived: number;
  truncated: boolean;
  truncatedAt?: number;
  headers?: HeaderMap;
  tls?: TlsInfo;
  timing?: TimingInfo;
  redirectChain?: RedirectChain;
  cookies?: CookieInfo[];
  budget: { metadataBytes: number; cap: typeof METADATA_BUDGET_BYTES };
}

export type WebFetchErrorKind =
  | "validation"
  | "blocked-scheme"
  | "blocked-address"
  | "binary-content"
  | "redirect-limit"
  | "timeout"
  | "http-error"
  | "network"
  | "decode";

export interface WebFetchError {
  kind: WebFetchErrorKind;
  message: string;
  status?: number;
  url?: string;
  bodyPreview?: string;
}

export interface WebFetchOutcome {
  ok: boolean;
  metadata: WebFetchMetadata;
  body: string;
  error?: WebFetchError;
}
