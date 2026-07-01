/**
 * `Capture` — pure observation builder for a single `web.fetch` invocation.
 * The transport in `fetch-core.ts` feeds it DNS/TCP/TLS/header/redirect/
 * cookie events; it accumulates them into the {@link WebFetchMetadata}
 * fields (timing, TLS info, headers, redirect chain, resolved IP/hostname,
 * cookies — each capped, see MAX_REDIRECT_HOPS/MAX_COOKIES_CAPTURED).
 *
 * Only the last hop's timing/DNS/TLS values are kept on redirect. No I/O
 * happens here — it's a pure data sink so the transport layer can be
 * tested independently. Redaction and the 64 KiB metadata budget are
 * applied later by `redact.ts` / `budget.ts`.
 */

import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { TLSSocket } from "node:tls";

import { parseSetCookie } from "./readable.js";
import {
  MAX_COOKIES_CAPTURED,
  MAX_REDIRECT_HOPS,
  type CookieInfo,
  type HeaderMap,
  type RedirectChain,
  type RedirectHop,
  type TimingInfo,
  type TlsInfo,
} from "./types.js";

/**
 * Snapshot of the structured fields the builder has accumulated when
 * `fetch-core.ts` finalises the response. The shape matches the slice of
 * {@link WebFetchMetadata} that depends on per-hop transport
 * observation; the fetch handler combines this with `requestedUrl`,
 * `finalUrl`, `mode`, `bytesReceived`, `truncated`, etc. before applying
 * `redact.applyToHeaders` / `redact.applyToCookies` and `budget.enforce`.
 */
export interface CapturedFields {
  /** IP address contacted on the final hop. */
  resolvedIp: string;
  /** Hostname of the final hop (the one whose body is returned). */
  finalHostname: string;
  /** Integer HTTP status of the final response. */
  status: number;
  /** Lowercased response headers from the final hop, repeats joined. */
  headers: HeaderMap;
  /** TLS session details from the final hop, when the scheme was https. */
  tls?: TlsInfo;
  /** Per-phase timings; `tlsMs` is omitted on http:// requests. */
  timing: TimingInfo;
  /** Up to {@link MAX_REDIRECT_HOPS} hops in chronological order. */
  redirectChain: RedirectChain;
  /** Up to {@link MAX_COOKIES_CAPTURED} cookies parsed from `Set-Cookie`. */
  cookies: CookieInfo[];
}

/**
 * Pure builder that records the per-hop observations made by
 * `fetch-core.ts` and assembles them into a {@link CapturedFields}
 * snapshot via {@link Capture.finalize}.
 *
 * The builder is single-use: callers should construct one `Capture` per
 * `web.fetch` invocation and discard it after `finalize`.
 */
export class Capture {
  /** Final-hop DNS-resolution time in milliseconds. */
  private dnsMs = 0;
  /** Final-hop TCP-connect time in milliseconds. */
  private tcpMs = 0;
  /** Final-hop TLS-handshake time in milliseconds (https only). */
  private tlsMs: number | undefined = undefined;
  /** Final-hop time-to-first-byte in milliseconds. */
  private ttfbMs = 0;

  /** Final-hop resolved IP, set by {@link markDnsResolved}. */
  private resolvedIp = "";
  /** Final-hop hostname, set by {@link setHopContext}. */
  private finalHostname = "";
  /** Final-hop HTTP status, set by {@link markResponse}. */
  private status = 0;
  /** Final-hop normalised headers, set by {@link markResponse}. */
  private headers: HeaderMap = {};
  /** Final-hop TLS info (https only), set by {@link markTlsHandshaked}. */
  private tls: TlsInfo | undefined = undefined;
  /** Redirect hops, capped at {@link MAX_REDIRECT_HOPS}. */
  private readonly redirectChain: RedirectHop[] = [];
  /** Captured cookies, capped at {@link MAX_COOKIES_CAPTURED}. */
  private readonly cookies: CookieInfo[] = [];

  /**
   * Whether the current invocation is an `https://` fetch. When `false`,
   * `tlsMs` is omitted from {@link TimingInfo} and `tls` from
   * {@link CapturedFields} per Requirements 2.16, 2.24, and 2.25.
   */
  private readonly isHttps: boolean;

  /**
   * Construct a fresh builder.
   *
   * @param opts.isHttps - Whether the request URL used `https://`.
   *   Controls whether `timing.tlsMs` and `tls` are populated.
   * @param opts.finalHostname - Optional initial hostname; the transport
   *   will overwrite this via {@link setHopContext} as redirects are
   *   followed.
   */
  constructor(opts: { isHttps: boolean; finalHostname?: string }) {
    this.isHttps = opts.isHttps;
    if (typeof opts.finalHostname === "string") {
      this.finalHostname = opts.finalHostname;
    }
  }

  /**
   * Record the hostname of the hop the transport is about to issue.
   *
   * Called once per hop, before {@link markDnsResolved}. The most-recent
   * value becomes {@link CapturedFields.finalHostname}.
   */
  setHopContext(hostname: string): void {
    if (typeof hostname === "string" && hostname.length > 0) {
      this.finalHostname = hostname;
    }
  }

  /**
   * Record the DNS-resolution outcome for the current hop.
   *
   * The most-recent values overwrite any earlier ones so the values
   * surfaced in {@link TimingInfo.dnsMs} and
   * {@link CapturedFields.resolvedIp} correspond to the final hop.
   */
  markDnsResolved(ms: number, ip: string): void {
    this.dnsMs = sanitiseMs(ms);
    if (typeof ip === "string" && ip.length > 0) {
      this.resolvedIp = ip;
    }
  }

  /**
   * Record the TCP-connect time for the current hop. The most-recent
   * value wins (see class-level docstring for per-hop semantics).
   */
  markTcpConnected(ms: number): void {
    this.tcpMs = sanitiseMs(ms);
  }

  /**
   * Record the TLS handshake time and extract {@link TlsInfo} from the
   * final-hop `tls.TLSSocket`.
   *
   * - `protocol`           ← `socket.getProtocol()` (`""` if null).
   * - `cipher`             ← `socket.getCipher().name` (`""` if missing).
   * - `subjectCN/issuerCN` ← `cert.subject.CN` / `cert.issuer.CN`.
   * - `subjectAltNames`    ← parsed from `cert.subjectaltname`.
   * - `notBefore/notAfter` ← `cert.valid_from` / `cert.valid_to` parsed
   *                          to ISO 8601 (falls back to the raw value).
   * - `fingerprintSha256`  ← lowercase, colon-separated SHA-256 of
   *                          `cert.raw` via `node:crypto`.
   *
   * Calling this method on an http:// fetch is harmless but pointless —
   * the constructor's `isHttps=false` flag suppresses the field in
   * {@link finalize} regardless.
   */
  markTlsHandshaked(ms: number, socket: TLSSocket): void {
    this.tlsMs = sanitiseMs(ms);
    this.tls = extractTlsInfo(socket);
  }

  /**
   * Record the final-hop response: HTTP status, raw headers
   * (lowercased and joined into a {@link HeaderMap}), and TTFB.
   *
   * `Set-Cookie` is preserved in `headers` joined with `, ` like every
   * other repeated header so the audit/redact passes can act on it.
   * Per-cookie capture happens via {@link addSetCookieHeader}, which
   * `fetch-core.ts` calls once per `Set-Cookie` line observed.
   */
  markResponse(
    status: number,
    rawHeaders: IncomingHttpHeaders,
    ttfbMs: number,
  ): void {
    this.status = Number.isInteger(status) ? status : 0;
    this.ttfbMs = sanitiseMs(ttfbMs);
    this.headers = normaliseHeaders(rawHeaders);
  }

  /**
   * Append a redirect hop to the chronological chain.
   *
   * Hops in excess of {@link MAX_REDIRECT_HOPS} are silently dropped so
   * the array always satisfies the cap from Requirement 2.26.
   * `fetch-core.ts` is responsible for surfacing the
   * `redirect-limit` error when the cap is reached; this builder just
   * stops accumulating.
   */
  addRedirectHop(url: string, status: number, location?: string): void {
    if (this.redirectChain.length >= MAX_REDIRECT_HOPS) return;
    if (typeof url !== "string" || url.length === 0) return;
    const hop: RedirectHop = {
      url,
      status: Number.isInteger(status) ? status : 0,
    };
    if (typeof location === "string" && location.length > 0) {
      hop.location = location;
    }
    this.redirectChain.push(hop);
  }

  /**
   * Parse one `Set-Cookie` header value via {@link parseSetCookie} and
   * append the resulting {@link CookieInfo}, bounded at
   * {@link MAX_COOKIES_CAPTURED}.
   *
   * Cookies in excess of the cap are silently dropped, matching
   * Requirement 2.31.
   */
  addSetCookieHeader(value: string): void {
    if (this.cookies.length >= MAX_COOKIES_CAPTURED) return;
    if (typeof value !== "string" || value.length === 0) return;
    this.cookies.push(parseSetCookie(value));
  }

  /**
   * Produce the {@link CapturedFields} snapshot.
   *
   * @param totalMs - Wall-clock duration of the whole invocation, in
   *   milliseconds. Stored in {@link TimingInfo.totalMs}.
   *
   * Optional fields obey the design's "include flags applied at the
   * adapter, not at the builder" principle: this method always emits
   * every field it observed, including `tls` (when `isHttps=true` and a
   * handshake was captured). The fetch handler in `fetch.ts` is
   * responsible for honouring `includeTls` / `includeTiming` /
   * `includeRedirectChain` by stripping fields from the assembled
   * {@link WebFetchMetadata} *after* this snapshot is produced.
   */
  finalize(totalMs: number): CapturedFields {
    const timing: TimingInfo = {
      dnsMs: this.dnsMs,
      tcpMs: this.tcpMs,
      ttfbMs: this.ttfbMs,
      totalMs: sanitiseMs(totalMs),
    };
    if (this.isHttps && this.tlsMs !== undefined) {
      timing.tlsMs = this.tlsMs;
    }

    const fields: CapturedFields = {
      resolvedIp: this.resolvedIp,
      finalHostname: this.finalHostname,
      status: this.status,
      headers: this.headers,
      timing,
      redirectChain: this.redirectChain.slice(),
      cookies: this.cookies.slice(),
    };
    if (this.isHttps && this.tls !== undefined) {
      fields.tls = this.tls;
    }
    return fields;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Coerce an arbitrary millisecond value into a non-negative finite
 * integer. Used to keep timing arithmetic resilient to clock skew or
 * non-numeric inputs from a stubbed transport.
 */
function sanitiseMs(ms: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return 0;
  if (ms < 0) return 0;
  return Math.round(ms);
}

/**
 * Lower-case every header key and join repeat values per RFC 7230 with
 * `, ` so the `redact`/`budget` passes downstream see a uniform
 * `Record<string, string>` shape. Header-value length truncation is
 * deferred to `redact.applyToHeaders` (4096-char cap from
 * Requirement 2.21) so this builder stays purely observational.
 */
function normaliseHeaders(raw: IncomingHttpHeaders): HeaderMap {
  const out: HeaderMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const lowerKey = key.toLowerCase();
    if (Array.isArray(value)) {
      out[lowerKey] = value.join(", ");
    } else {
      out[lowerKey] = String(value);
    }
  }
  return out;
}

/**
 * Pull the TLS session details we surface from the leaf certificate.
 *
 * `getCipher()` returns `null` for sessions that have not completed the
 * handshake — defensive `?? ""` keeps the field present rather than
 * throwing when fed a half-initialised socket from a test stub.
 */
function extractTlsInfo(socket: TLSSocket): TlsInfo {
  const protocol = socket.getProtocol() ?? "";
  const cipherInfo = socket.getCipher();
  const cipher = cipherInfo?.name ?? "";

  // `getPeerCertificate(true)` returns the detailed certificate object
  // including the DER `raw` bytes we need for the SHA-256 fingerprint.
  // Some test stubs return a plain object lacking `raw`; we guard for
  // that with a typeof check below.
  const cert = socket.getPeerCertificate(true);

  const subjectCN = pickCN(cert?.subject?.CN);
  const issuerCN = pickCN(cert?.issuer?.CN);
  const subjectAltNames = parseSubjectAltName(cert?.subjectaltname);
  const notBefore = isoFromCertDate(cert?.valid_from);
  const notAfter = isoFromCertDate(cert?.valid_to);
  const fingerprintSha256 = computeSha256Fingerprint(cert?.raw);

  return {
    protocol,
    cipher,
    subjectCN,
    issuerCN,
    subjectAltNames,
    notBefore,
    notAfter,
    fingerprintSha256,
  };
}

/**
 * `tls.Certificate.CN` is typed as `string | string[] | undefined`.
 * When multiple CN values are present, we take the first to keep the
 * field shape simple; SAN expansion already covers the multi-name case.
 */
function pickCN(cn: string | string[] | undefined): string {
  if (typeof cn === "string") return cn;
  if (Array.isArray(cn) && cn.length > 0) {
    return typeof cn[0] === "string" ? cn[0] : "";
  }
  return "";
}

/**
 * Parse `cert.subjectaltname` (the comma-separated string emitted by
 * Node's `getPeerCertificate`, e.g. `"DNS:example.com, IP Address:1.2.3.4"`)
 * into a string array. The type prefix (`DNS:`, `IP Address:`, `URI:`,
 * `email:`) is preserved so callers retain SAN-type information.
 *
 * Empty / undefined input yields an empty array.
 */
function parseSubjectAltName(san: string | undefined): string[] {
  if (typeof san !== "string" || san.length === 0) return [];
  return san
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Convert a certificate `valid_from`/`valid_to` date string (which uses
 * the OpenSSL `MMM DD HH:mm:ss YYYY GMT` format) into ISO 8601. Falls
 * back to the raw input when parsing fails so the field remains useful
 * for forensic review even if the format is unexpected.
 */
function isoFromCertDate(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString();
}

/**
 * Compute the SHA-256 digest of the certificate's DER bytes via
 * `node:crypto` and format it as a lowercase, colon-separated hex
 * string (`"ab:cd:ef:..."`), matching the `cert.fingerprint256` shape
 * Node exposes for SHA-1 digests.
 *
 * Returns `""` when `raw` is missing or not a Buffer-like value (e.g. a
 * test stub that omitted the field).
 */
function computeSha256Fingerprint(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  let bytes: Buffer;
  if (Buffer.isBuffer(raw)) {
    bytes = raw;
  } else if (raw instanceof Uint8Array) {
    bytes = Buffer.from(raw);
  } else {
    return "";
  }
  const hex = createHash("sha256").update(bytes).digest("hex");
  // Pair-up the hex string into colon-separated bytes: `abcdef…` →
  // `ab:cd:ef:…`. The regex match is bounded by the deterministic
  // 64-char output of SHA-256 so there is no unbounded work here.
  const pairs = hex.match(/.{2}/g) ?? [];
  return pairs.join(":");
}
