/**
 * Audit-log payload builders for the `web.search` and `web.fetch` tools.
 *
 * Both tools must emit exactly one structured `auditLog` entry per
 * invocation (Requirements 5.5 / 5.6). This module is the single source
 * of truth for the *shape* of those entries; `search.ts` and `fetch.ts`
 * call these builders and pass the result straight to `auditLog`.
 *
 * The payloads enforce two non-negotiable invariants on top of the
 * field lists in the requirements:
 *
 *  1. **No secret leaks**. Header values and cookie values are routed
 *     through {@link stripForAudit} before they hit the payload, so
 *     sensitive headers (`Cookie`, `Set-Cookie`, `Authorization`,
 *     `Proxy-Authorization`) are removed entirely and cookies are
 *     reduced to `{name, domain, path, httpOnly, secure, sameSite}` —
 *     never the cookie value, regardless of `redactSensitive`
 *     (Requirements 5.11–5.13).
 *  2. **Stable shape**. Every field listed in the requirements is
 *     either always present (requested/final URL, status, byte count,
 *     resolved IP, final hostname, response mode, hop count) or guarded
 *     by the corresponding `metadata.<field>` having been produced
 *     (TLS, timing, redirect chain, cookies). Optional fields are
 *     emitted iff their underlying metadata exists, so property tests
 *     can assert presence/absence deterministically.
 *
 * The query *text* is intentionally never put on the payload — the
 * search audit log carries `queryLength` only, per Requirement 5.5.
 * The fetch response body, request body, and any `Authorization`
 * / `Cookie` request header values are likewise excluded by
 * construction (Requirements 5.12, 5.13).
 */

import { stripForAudit, type AuditSafeCookie } from "./redact.js";
import type {
  HeaderMap,
  ResponseMode,
  SearchProviderId,
  WebFetchOutcome,
  WebSearchOutcome,
} from "./types.js";

// ---------------------------------------------------------------------------
// Shared payload sub-shapes
// ---------------------------------------------------------------------------

/**
 * Categorical error description embedded in either audit payload when
 * `outcome.ok === false`. The `kind` discriminator mirrors the matching
 * `Web*ErrorKind` union from `types.ts` so consumers (and the property
 * tests in 7.6) can switch on it without re-parsing the message.
 */
export interface AuditError {
  kind: string;
  message: string;
  status?: number;
}

/**
 * Subset of {@link TlsInfo} surfaced to the audit log. The full
 * `subjectAltNames` list and `notBefore` are intentionally omitted —
 * the requirements (5.8) call for the seven fields below and nothing
 * else; including more would only widen the audit log surface.
 */
export interface AuditTlsInfo {
  protocol: string;
  cipher: string;
  subjectCN: string;
  issuerCN: string;
  notAfter: string;
  fingerprintSha256: string;
}

/** Per-phase millisecond timings copied straight from {@link TimingInfo}. */
export interface AuditTimingInfo {
  dnsMs: number;
  tcpMs: number;
  /** Present iff the URL was `https://` (Requirement 5.9). */
  tlsMs?: number;
  ttfbMs: number;
  totalMs: number;
}

/**
 * Single redirect hop entry in the audit log. Per Requirement 5.10 the
 * audit payload only carries `url` and `status` — the `Location` header
 * value is dropped because it can echo a session-bearing query string
 * that the redact pass would not otherwise classify as sensitive.
 */
export interface AuditRedirectHop {
  url: string;
  status: number;
}

// ---------------------------------------------------------------------------
// web.search
// ---------------------------------------------------------------------------

/**
 * Audit payload shape emitted for `tool.web_search`. Mirrors the field
 * list in Requirement 5.5: provider id, integer query length, integer
 * result count, outcome status (`ok`), and a categorical error block
 * when the invocation failed.
 *
 * The query text itself never appears here.
 */
export interface SearchAuditPayload {
  ok: boolean;
  provider: SearchProviderId;
  queryLength: number;
  resultCount: number;
  error?: AuditError;
}

/**
 * Build the audit payload for a single `web.search` invocation.
 *
 * The caller passes the trimmed query length explicitly because the
 * outcome object does not carry it (the query text is dropped before
 * the outcome leaves the handler, by design — see Requirement 5.5).
 * `queryLength` is clamped to `>= 0` and coerced to a non-negative
 * integer so a malformed caller cannot inject a string or negative
 * value into the audit log.
 */
export function buildSearchAuditPayload(
  outcome: WebSearchOutcome,
  queryLength: number,
): SearchAuditPayload {
  const safeLength = Number.isFinite(queryLength)
    ? Math.max(0, Math.trunc(queryLength))
    : 0;

  const payload: SearchAuditPayload = {
    ok: outcome.ok,
    provider: outcome.provider,
    queryLength: safeLength,
    resultCount: Array.isArray(outcome.results) ? outcome.results.length : 0,
  };

  if (outcome.error) {
    const err: AuditError = {
      kind: outcome.error.kind,
      message: outcome.error.message,
    };
    if (typeof outcome.error.status === "number") {
      err.status = outcome.error.status;
    }
    payload.error = err;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// web.fetch
// ---------------------------------------------------------------------------

/**
 * Audit payload shape emitted for `tool.web_fetch`. Required fields are
 * always present (Requirements 5.6–5.7); the optional sub-objects are
 * present iff the corresponding metadata stage produced output:
 *
 *  - `tls`           when {@link WebFetchMetadata.tls} is defined
 *                      (Requirement 5.8).
 *  - `timing`        when {@link WebFetchMetadata.timing} is defined
 *                      (Requirement 5.9).
 *  - `redirectChain` when {@link WebFetchMetadata.redirectChain} is
 *                      defined and non-empty (Requirement 5.10).
 *  - `headers`       when {@link WebFetchMetadata.headers} is defined,
 *                      with sensitive header keys stripped entirely
 *                      (Requirement 5.12).
 *  - `cookies`       when {@link WebFetchMetadata.cookies} is defined
 *                      and non-empty, reduced to the
 *                      {@link AuditSafeCookie} shape (Requirement 5.11).
 */
export interface FetchAuditPayload {
  ok: boolean;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  bytesReceived: number;
  resolvedIp: string;
  finalHostname: string;
  responseMode: ResponseMode;
  hopCount: number;
  headers?: HeaderMap;
  cookies?: AuditSafeCookie[];
  tls?: AuditTlsInfo;
  timing?: AuditTimingInfo;
  redirectChain?: AuditRedirectHop[];
  error?: AuditError;
}

/**
 * Build the audit payload for a single `web.fetch` invocation.
 *
 * Routes `outcome.metadata.headers` and `outcome.metadata.cookies`
 * through {@link stripForAudit} unconditionally so the audit log
 * never carries a `Cookie` / `Set-Cookie` / `Authorization` /
 * `Proxy-Authorization` value, nor any cookie's `value`,
 * `expires`, or `maxAge` (Requirements 5.11, 5.12).
 *
 * The `body` field of the outcome is intentionally never read here —
 * the response body is excluded from the audit log per Requirement 5.6
 * and the request body never enters the outcome shape per
 * Requirement 5.13.
 */
export function buildFetchAuditPayload(
  outcome: WebFetchOutcome,
): FetchAuditPayload {
  const meta = outcome.metadata;

  // Always-on redaction of headers and cookies for audit. See the
  // module-level invariant (1): the audit log never sees sensitive
  // header *values* nor any cookie *value*, regardless of the user's
  // `redactSensitive` choice.
  const safe = stripForAudit(meta.headers, meta.cookies);

  const payload: FetchAuditPayload = {
    ok: outcome.ok,
    requestedUrl: meta.requestedUrl,
    finalUrl: meta.finalUrl,
    status: Math.trunc(meta.status) || 0,
    bytesReceived: Math.max(0, Math.trunc(meta.bytesReceived) || 0),
    resolvedIp: meta.resolvedIp,
    finalHostname: meta.finalHostname,
    responseMode: meta.mode,
    hopCount: meta.redirectChain ? meta.redirectChain.length : 0,
  };

  if (meta.headers !== undefined) {
    payload.headers = safe.headers;
  }
  if (meta.cookies !== undefined && safe.cookies.length > 0) {
    payload.cookies = safe.cookies;
  }

  if (meta.tls) {
    payload.tls = {
      protocol: meta.tls.protocol,
      cipher: meta.tls.cipher,
      subjectCN: meta.tls.subjectCN,
      issuerCN: meta.tls.issuerCN,
      notAfter: meta.tls.notAfter,
      fingerprintSha256: meta.tls.fingerprintSha256,
    };
  }

  if (meta.timing) {
    const t: AuditTimingInfo = {
      dnsMs: meta.timing.dnsMs,
      tcpMs: meta.timing.tcpMs,
      ttfbMs: meta.timing.ttfbMs,
      totalMs: meta.timing.totalMs,
    };
    if (typeof meta.timing.tlsMs === "number") {
      t.tlsMs = meta.timing.tlsMs;
    }
    payload.timing = t;
  }

  if (meta.redirectChain && meta.redirectChain.length > 0) {
    // Requirement 5.10: chronological, capped at 5. The pipeline already
    // caps at MAX_REDIRECT_HOPS, but slice defensively to make this
    // helper safe to call from tests with synthetic outcomes.
    payload.redirectChain = meta.redirectChain.slice(0, 5).map((hop) => ({
      url: hop.url,
      status: Math.trunc(hop.status) || 0,
    }));
  }

  if (outcome.error) {
    const err: AuditError = {
      kind: outcome.error.kind,
      message: outcome.error.message,
    };
    if (typeof outcome.error.status === "number") {
      err.status = outcome.error.status;
    }
    payload.error = err;
  }

  return payload;
}
