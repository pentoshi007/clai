/**
 * Shared TypeScript types for the `web.search` and `web.fetch` tools.
 *
 * Field shapes, ranges, and defaults match the "Data Models" section of
 * `.kiro/specs/web-search-and-fetch/design.md` and the acceptance
 * criteria in Requirements 1, 2, and 7.
 */

// ---------------------------------------------------------------------------
// web.search
// ---------------------------------------------------------------------------

/**
 * Identifier of a search provider supported by the Web_Search_Tool.
 *
 * The set is intentionally independent of the LLM `ProviderId` union so the
 * two keyspaces stay decoupled.
 */
export type SearchProviderId = "brave" | "tavily" | "duckduckgo";

/** Convenience tuple form of the {@link SearchProviderId} union. */
export const searchProviderIds: readonly SearchProviderId[] = [
  "brave",
  "tavily",
  "duckduckgo",
] as const;

/**
 * Arguments accepted by the `web.search` tool.
 *
 * - `query`: 1..400 chars after trimming leading/trailing whitespace
 *   (Requirement 1.1).
 * - `maxResults`: integer in `[1, 20]`; defaults to 5 when omitted
 *   (Requirement 1.2).
 */
export interface WebSearchArgs {
  query: string;
  maxResults?: number;
}

/** Default value applied when `WebSearchArgs.maxResults` is omitted. */
export const DEFAULT_MAX_RESULTS = 5;

/** Inclusive minimum allowed for `WebSearchArgs.maxResults`. */
export const MIN_MAX_RESULTS = 1;

/** Inclusive maximum allowed for `WebSearchArgs.maxResults`. */
export const MAX_MAX_RESULTS = 20;

/** Inclusive minimum allowed for `WebSearchArgs.query` length after trim. */
export const MIN_QUERY_LENGTH = 1;

/** Inclusive maximum allowed for `WebSearchArgs.query` length after trim. */
export const MAX_QUERY_LENGTH = 400;

/**
 * A single search hit returned by `web.search`.
 *
 * - `title`: 1..512 chars (Requirement 1.3).
 * - `url`: absolute URL with scheme `http://` or `https://`, no whitespace,
 *   no ASCII control characters (Requirements 1.3, 7.1, 7.3).
 * - `snippet`: 0..2048 chars (Requirement 1.3).
 */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Inclusive minimum allowed for `SearchResult.title` length. */
export const MIN_TITLE_LENGTH = 1;

/** Inclusive maximum allowed for `SearchResult.title` length. */
export const MAX_TITLE_LENGTH = 512;

/** Inclusive minimum allowed for `SearchResult.snippet` length. */
export const MIN_SNIPPET_LENGTH = 0;

/** Inclusive maximum allowed for `SearchResult.snippet` length. */
export const MAX_SNIPPET_LENGTH = 2048;

/**
 * Categorical kinds of failures the `web.search` pipeline can surface.
 *
 * The mapping to acceptance criteria is:
 * - `auth`        → Requirement 6.1 (401/403)
 * - `rate-limit`  → Requirement 6.2 (429)
 * - `network`     → Requirement 6.3 (DNS/connect/TLS)
 * - `parse`       → Requirement 6.5 (bad provider response)
 * - `server`      → Requirement 6.6 (5xx)
 * - `http`        → Requirement 1.9 (other non-2xx)
 * - `timeout`     → Requirement 1.8 (>15 s elapsed)
 * - `missing-key` → Requirement 3.4
 * - `validation`  → Requirements 1.5, 1.6
 */
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

/** Structured failure detail accompanying an `ok=false` search outcome. */
export interface WebSearchError {
  kind: WebSearchErrorKind;
  provider: SearchProviderId;
  status?: number;
  message: string;
}

/**
 * Internal typed result of a `web.search` invocation, prior to being
 * adapted into a `ToolResult` by the registry handler.
 */
export interface WebSearchOutcome {
  ok: boolean;
  provider: SearchProviderId;
  /** At most `maxResults` entries; may be empty (Requirement 1.7). */
  results: SearchResult[];
  error?: WebSearchError;
}

// ---------------------------------------------------------------------------
// web.fetch
// ---------------------------------------------------------------------------

/**
 * Mode controlling how the `web.fetch` tool emits the response body.
 *
 * - `readable`: HTML/XHTML stripped to text; non-HTML text passed through
 *   (Requirements 2.4, 2.5, 2.28).
 * - `raw`: response bytes decoded as UTF-8 with replacement, truncated to
 *   `maxBytes` (Requirement 2.29).
 */
export type ResponseMode = "readable" | "raw";

/** Allowed values for `WebFetchArgs.responseMode`. */
export const RESPONSE_MODES: readonly ResponseMode[] = [
  "readable",
  "raw",
] as const;

/**
 * Arguments accepted by the `web.fetch` tool.
 *
 * Defaults applied when an optional argument is omitted:
 * - `maxBytes`             → {@link DEFAULT_MAX_BYTES}        (Requirement 2.2)
 * - `includeHeaders`       → `true`                           (Requirement 2.15)
 * - `includeTls`           → `true` for `https://`, `false` for `http://`
 *                             (Requirement 2.16)
 * - `includeTiming`        → `true`                           (Requirement 2.17)
 * - `includeRedirectChain` → `true`                           (Requirement 2.18)
 * - `responseMode`         → `"readable"`                     (Requirement 2.19)
 * - `redactSensitive`      → `true`                           (Requirement 2.20)
 */
export interface WebFetchArgs {
  url: string;
  maxBytes?: number;
  includeHeaders?: boolean;
  includeTls?: boolean;
  includeTiming?: boolean;
  includeRedirectChain?: boolean;
  responseMode?: ResponseMode;
  redactSensitive?: boolean;
}

/** Default value applied when `WebFetchArgs.maxBytes` is omitted. */
export const DEFAULT_MAX_BYTES = 262_144;

/** Inclusive minimum allowed for `WebFetchArgs.maxBytes`. */
export const MIN_MAX_BYTES = 1024;

/** Inclusive maximum allowed for `WebFetchArgs.maxBytes`. */
export const MAX_MAX_BYTES = 1_048_576;

/** Default value applied when `WebFetchArgs.includeHeaders` is omitted. */
export const DEFAULT_INCLUDE_HEADERS = true;

/** Default value applied when `WebFetchArgs.includeTiming` is omitted. */
export const DEFAULT_INCLUDE_TIMING = true;

/** Default value applied when `WebFetchArgs.includeRedirectChain` is omitted. */
export const DEFAULT_INCLUDE_REDIRECT_CHAIN = true;

/** Default value applied when `WebFetchArgs.responseMode` is omitted. */
export const DEFAULT_RESPONSE_MODE: ResponseMode = "readable";

/** Default value applied when `WebFetchArgs.redactSensitive` is omitted. */
export const DEFAULT_REDACT_SENSITIVE = true;

/** Maximum number of redirect hops followed per `web.fetch` invocation. */
export const MAX_REDIRECT_HOPS = 5;

/** Maximum number of `Set-Cookie` entries captured per invocation. */
export const MAX_COOKIES_CAPTURED = 32;

/** Per-header-value character cap before `[...truncated]` is appended. */
export const MAX_HEADER_VALUE_LENGTH = 4096;

/** Marker appended to any header value or body preview shortened by the tool. */
export const TRUNCATION_MARKER = "[...truncated]";

/** Literal placeholder used wherever sensitive values are redacted. */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/** Combined serialized-size cap for fetch metadata in bytes. */
export const METADATA_BUDGET_BYTES = 65_536;

/** Maximum size in bytes of the `bodyPreview` returned for HTTP errors. */
export const HTTP_ERROR_BODY_PREVIEW_BYTES = 4096;

/** Total wall-clock timeout in milliseconds for a `web.fetch` invocation. */
export const FETCH_TIMEOUT_MS = 30_000;

/** Total wall-clock timeout in milliseconds for a `web.search` invocation. */
export const SEARCH_TIMEOUT_MS = 15_000;

/**
 * Lower-cased map of HTTP response header names to string values.
 *
 * Each value is truncated to {@link MAX_HEADER_VALUE_LENGTH} characters with
 * the literal {@link TRUNCATION_MARKER} appended when shortened. Repeat
 * headers per RFC 7230 are joined with `", "`. (Requirement 2.21.)
 */
export type HeaderMap = Record<string, string>;

/**
 * TLS session details captured from the final hop of an `https://` fetch.
 *
 * Populated only when the request used `https://` and the user did not opt
 * out via `includeTls=false` (Requirements 2.23, 2.24).
 */
export interface TlsInfo {
  /** Negotiated protocol version, e.g. `"TLSv1.3"`. */
  protocol: string;
  /** Cipher suite name, e.g. `"TLS_AES_128_GCM_SHA256"`. */
  cipher: string;
  /** Subject Common Name from the leaf certificate. */
  subjectCN: string;
  /** Issuer Common Name from the leaf certificate. */
  issuerCN: string;
  /** Subject Alternative Names parsed from the leaf certificate. */
  subjectAltNames: string[];
  /** ISO 8601 timestamp from the leaf certificate's `notBefore` field. */
  notBefore: string;
  /** ISO 8601 timestamp from the leaf certificate's `notAfter` field. */
  notAfter: string;
  /**
   * Lowercase, colon-separated SHA-256 fingerprint of the leaf certificate's
   * DER bytes (e.g. `"ab:cd:..."`).
   */
  fingerprintSha256: string;
}

/**
 * One hop in the {@link RedirectChain}.
 *
 * - `url`: the URL that was requested at this hop.
 * - `status`: integer HTTP status returned by that request.
 * - `location`: value of the `Location` header on the redirect response, if
 *   the response was a redirect that produced a subsequent hop.
 */
export interface RedirectHop {
  url: string;
  status: number;
  location?: string;
}

/**
 * Ordered list of redirect hops, capped at {@link MAX_REDIRECT_HOPS}.
 *
 * The first entry is the originally requested URL; the last entry is the URL
 * whose response body is returned to the caller. (Requirement 2.26.)
 */
export type RedirectChain = RedirectHop[];

/**
 * Per-phase millisecond timing measurements captured during a fetch.
 *
 * `tlsMs` is present iff the requested URL used `https://`
 * (Requirement 2.25).
 */
export interface TimingInfo {
  dnsMs: number;
  tcpMs: number;
  tlsMs?: number;
  ttfbMs: number;
  totalMs: number;
}

/** Allowed values for {@link CookieInfo.sameSite}. */
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
  /** ISO 8601 timestamp from the `Expires` attribute, when present. */
  expires?: string;
  /** Numeric `Max-Age` attribute in seconds, when present. */
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: CookieSameSite;
}

/**
 * Structured metadata describing a completed `web.fetch` invocation.
 *
 * The `headers`, `tls`, `timing`, `redirectChain`, and `cookies` fields are
 * jointly capped at {@link METADATA_BUDGET_BYTES} when serialized
 * (Requirement 2.35), with the truncation order defined in
 * `design.md` "Truncation order at the 64 KiB cap".
 */
export interface WebFetchMetadata {
  /** URL exactly as requested by the caller. */
  requestedUrl: string;
  /** URL that returned the body (after any redirects). */
  finalUrl: string;
  /** Integer HTTP status code of the final response. */
  status: number;
  /** Final response `Content-Type`, when the server returned one. */
  contentType?: string;
  /** IP address contacted on the final hop (Requirement 2.27). */
  resolvedIp: string;
  /** Hostname of `finalUrl` (Requirement 2.27). */
  finalHostname: string;
  /** Effective response mode used to build `body`. */
  mode: ResponseMode;
  /** Number of body bytes the tool actually received. */
  bytesReceived: number;
  /** True iff `bytesReceived` reached `maxBytes` and the body was cut. */
  truncated: boolean;
  /** Byte offset at which truncation occurred, when `truncated=true`. */
  truncatedAt?: number;
  headers?: HeaderMap;
  tls?: TlsInfo;
  timing?: TimingInfo;
  redirectChain?: RedirectChain;
  /** At most {@link MAX_COOKIES_CAPTURED} entries (Requirement 2.31). */
  cookies?: CookieInfo[];
  /** Bookkeeping for the 64 KiB metadata cap. */
  budget: { metadataBytes: number; cap: typeof METADATA_BUDGET_BYTES };
}

/**
 * Categorical kinds of failures the `web.fetch` pipeline can surface.
 *
 * The mapping to acceptance criteria is:
 * - `validation`      → Requirements 2.12, 2.13, 2.33, 2.34
 * - `blocked-scheme`  → Requirements 2.1 / 5.4
 * - `blocked-address` → Requirements 2.8 / 5.3
 * - `binary-content`  → Requirements 2.9, 2.30
 * - `redirect-limit`  → Requirement 2.14
 * - `timeout`         → Requirement 2.10
 * - `http-error`      → Requirement 6.4 (4xx/5xx terminal)
 * - `network`         → Requirement 6.3 (DNS/connect/TLS underlying failure)
 * - `decode`          → raw decode failed (rare)
 */
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

/** Structured failure detail accompanying an `ok=false` fetch outcome. */
export interface WebFetchError {
  kind: WebFetchErrorKind;
  message: string;
  status?: number;
  /** Last URL attempted before the failure surfaced. */
  url?: string;
  /**
   * Up to {@link HTTP_ERROR_BODY_PREVIEW_BYTES} bytes of the failing
   * response body, included for `http-error` outcomes (Requirement 6.4).
   */
  bodyPreview?: string;
}

/**
 * Internal typed result of a `web.fetch` invocation, prior to being adapted
 * into a `ToolResult` by the registry handler.
 *
 * `body` carries either readable text or raw decoded UTF-8, depending on the
 * resolved {@link ResponseMode}.
 */
export interface WebFetchOutcome {
  ok: boolean;
  metadata: WebFetchMetadata;
  body: string;
  error?: WebFetchError;
}
