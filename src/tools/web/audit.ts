
import { stripForAudit, type AuditSafeCookie } from "./redact.js";
import type {
  HeaderMap,
  ResponseMode,
  SearchProviderId,
  WebFetchOutcome,
  WebSearchOutcome,
} from "./types.js";


export interface AuditError {
  kind: string;
  message: string;
  status?: number;
}

export interface AuditTlsInfo {
  protocol: string;
  cipher: string;
  subjectCN: string;
  issuerCN: string;
  notAfter: string;
  fingerprintSha256: string;
}

export interface AuditTimingInfo {
  dnsMs: number;
  tcpMs: number;
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


export interface SearchAuditPayload {
  ok: boolean;
  provider: SearchProviderId;
  queryLength: number;
  resultCount: number;
  error?: AuditError;
}

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

export function buildFetchAuditPayload(
  outcome: WebFetchOutcome,
): FetchAuditPayload {
  const meta = outcome.metadata;

  // Always-on redaction of headers and cookies for audit. See the
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
