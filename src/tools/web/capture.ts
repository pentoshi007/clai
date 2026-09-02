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
  resolvedIp: string;
  finalHostname: string;
  status: number;
  headers: HeaderMap;
  tls?: TlsInfo;
  timing: TimingInfo;
  redirectChain: RedirectChain;
  cookies: CookieInfo[];
}

export class Capture {
  private dnsMs = 0;
  private tcpMs = 0;
  private tlsMs: number | undefined = undefined;
  private ttfbMs = 0;

  private resolvedIp = "";
  private finalHostname = "";
  private status = 0;
  private headers: HeaderMap = {};
  private tls: TlsInfo | undefined = undefined;
  private readonly redirectChain: RedirectHop[] = [];
  private readonly cookies: CookieInfo[] = [];

  private readonly isHttps: boolean;

  constructor(opts: { isHttps: boolean; finalHostname?: string }) {
    this.isHttps = opts.isHttps;
    if (typeof opts.finalHostname === "string") {
      this.finalHostname = opts.finalHostname;
    }
  }

  setHopContext(hostname: string): void {
    if (typeof hostname === "string" && hostname.length > 0) {
      this.finalHostname = hostname;
    }
  }

  markDnsResolved(ms: number, ip: string): void {
    this.dnsMs = sanitiseMs(ms);
    if (typeof ip === "string" && ip.length > 0) {
      this.resolvedIp = ip;
    }
  }

  markTcpConnected(ms: number): void {
    this.tcpMs = sanitiseMs(ms);
  }

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

  addSetCookieHeader(value: string): void {
    if (this.cookies.length >= MAX_COOKIES_CAPTURED) return;
    if (typeof value !== "string" || value.length === 0) return;
    this.cookies.push(parseSetCookie(value));
  }

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

function extractTlsInfo(socket: TLSSocket): TlsInfo {
  const protocol = socket.getProtocol() ?? "";
  const cipherInfo = socket.getCipher();
  const cipher = cipherInfo?.name ?? "";

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

function pickCN(cn: string | string[] | undefined): string {
  if (typeof cn === "string") return cn;
  if (Array.isArray(cn) && cn.length > 0) {
    return typeof cn[0] === "string" ? cn[0] : "";
  }
  return "";
}

function parseSubjectAltName(san: string | undefined): string[] {
  if (typeof san !== "string" || san.length === 0) return [];
  return san
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function isoFromCertDate(value: string | undefined): string {
  if (typeof value !== "string" || value.length === 0) return "";
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return value;
  return new Date(ms).toISOString();
}

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
  const pairs = hex.match(/.{2}/g) ?? [];
  return pairs.join(":");
}
