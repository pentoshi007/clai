// Feature: web-search-and-fetch, Task 5.1: audit-log payload builders
//
// Unit tests for `src/tools/web/audit.ts`. Verifies:
//
//   • `buildSearchAuditPayload` produces the exact field shape required
//     by Requirement 5.5 — provider id, integer query length, integer
//     result count, outcome status — and never carries the query text.
//
//   • `buildFetchAuditPayload` produces the field shape required by
//     Requirements 5.6–5.13 — requested + final URL, integer status,
//     integer received-body byte count, outcome status, resolved IP,
//     final hostname, response mode, hop count; plus the optional
//     TLS / timing / redirect / cookie fields whenever the matching
//     metadata was produced.
//
//   • Both helpers route headers and cookies through
//     `redact.stripForAudit` so sensitive header values (`Cookie`,
//     `Set-Cookie`, `Authorization`, `Proxy-Authorization`) and cookie
//     `value` / `expires` / `maxAge` fields never appear in the
//     serialized payload, regardless of the user's `redactSensitive`
//     setting (Requirements 5.11, 5.12, 5.13).

import { describe, expect, it } from "vitest";
import {
  buildFetchAuditPayload,
  buildSearchAuditPayload,
} from "../../src/tools/web/audit.js";
import {
  METADATA_BUDGET_BYTES,
  type CookieInfo,
  type HeaderMap,
  type TimingInfo,
  type TlsInfo,
  type WebFetchMetadata,
  type WebFetchOutcome,
  type WebSearchOutcome,
} from "../../src/tools/web/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** Sentinel string used to detect leaks of sensitive values into the audit payload. */
const LEAK_SENTINEL = "SHOULD-NEVER-APPEAR-IN-AUDIT";

function makeMinimalMetadata(
  overrides: Partial<WebFetchMetadata> = {},
): WebFetchMetadata {
  return {
    requestedUrl: "https://example.com/article",
    finalUrl: "https://example.com/article",
    status: 200,
    contentType: "text/html",
    resolvedIp: "93.184.216.34",
    finalHostname: "example.com",
    mode: "readable",
    bytesReceived: 1234,
    truncated: false,
    budget: { metadataBytes: 0, cap: METADATA_BUDGET_BYTES },
    ...overrides,
  };
}

const sampleHeaders: HeaderMap = {
  "content-type": "text/html; charset=utf-8",
  "x-frame-options": "DENY",
  // Sensitive header values — the audit payload must drop them entirely.
  authorization: `Bearer ${LEAK_SENTINEL}-auth`,
  cookie: `session=${LEAK_SENTINEL}-cookie-req`,
  "set-cookie": `sid=${LEAK_SENTINEL}-cookie-resp; Path=/`,
  "proxy-authorization": `Basic ${LEAK_SENTINEL}-proxy`,
};

const sampleCookies: CookieInfo[] = [
  {
    name: "sid",
    value: `${LEAK_SENTINEL}-cookie-value`,
    domain: "example.com",
    path: "/",
    expires: "2099-01-01T00:00:00.000Z",
    maxAge: 3600,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  },
  {
    name: "tracker",
    value: `${LEAK_SENTINEL}-cookie-tracker`,
    domain: "ads.example.com",
    path: "/t",
    secure: false,
    sameSite: "None",
  },
];

const sampleTls: TlsInfo = {
  protocol: "TLSv1.3",
  cipher: "TLS_AES_128_GCM_SHA256",
  subjectCN: "example.com",
  issuerCN: "Example CA",
  subjectAltNames: ["DNS:example.com", "DNS:www.example.com"],
  notBefore: "2024-01-01T00:00:00.000Z",
  notAfter: "2030-01-01T00:00:00.000Z",
  fingerprintSha256: "ab:cd:ef:00:11:22",
};

const sampleTiming: TimingInfo = {
  dnsMs: 12,
  tcpMs: 34,
  tlsMs: 56,
  ttfbMs: 78,
  totalMs: 200,
};

// ---------------------------------------------------------------------------
// buildSearchAuditPayload
// ---------------------------------------------------------------------------

describe("buildSearchAuditPayload", () => {
  it("returns the Requirement 5.5 field shape on success", () => {
    const outcome: WebSearchOutcome = {
      ok: true,
      provider: "duckduckgo",
      results: [
        { title: "a", url: "https://example.com/a", snippet: "x" },
        { title: "b", url: "https://example.com/b", snippet: "y" },
        { title: "c", url: "https://example.com/c", snippet: "z" },
      ],
    };

    const payload = buildSearchAuditPayload(outcome, /*queryLength*/ 17);

    expect(payload).toEqual({
      ok: true,
      provider: "duckduckgo",
      queryLength: 17,
      resultCount: 3,
    });
  });

  it("preserves the structured error block on failure", () => {
    const outcome: WebSearchOutcome = {
      ok: false,
      provider: "brave",
      results: [],
      error: {
        kind: "auth",
        provider: "brave",
        status: 401,
        message: "Brave returned 401. Run `clai set brave` to update the key.",
      },
    };

    const payload = buildSearchAuditPayload(outcome, 9);

    expect(payload).toEqual({
      ok: false,
      provider: "brave",
      queryLength: 9,
      resultCount: 0,
      error: {
        kind: "auth",
        status: 401,
        message: "Brave returned 401. Run `clai set brave` to update the key.",
      },
    });
  });

  it("never carries the query text", () => {
    const queryText = `${LEAK_SENTINEL}-search-query`;
    const outcome: WebSearchOutcome = {
      ok: true,
      provider: "duckduckgo",
      results: [
        { title: "t", url: "https://example.com/", snippet: "s" },
      ],
    };

    const payload = buildSearchAuditPayload(outcome, queryText.length);

    // The payload may not contain any substring of the query, only its length.
    expect(JSON.stringify(payload)).not.toContain(LEAK_SENTINEL);
    expect(payload.queryLength).toBe(queryText.length);
  });

  it("clamps non-finite or negative queryLength to 0 and truncates fractions", () => {
    const outcome: WebSearchOutcome = {
      ok: true,
      provider: "tavily",
      results: [],
    };

    expect(buildSearchAuditPayload(outcome, Number.NaN).queryLength).toBe(0);
    expect(buildSearchAuditPayload(outcome, -10).queryLength).toBe(0);
    expect(buildSearchAuditPayload(outcome, 12.9).queryLength).toBe(12);
  });

  it("counts results as 0 when the outcome has no results array", () => {
    const outcome = {
      ok: false,
      provider: "duckduckgo",
      // results intentionally absent — defensive coercion.
    } as unknown as WebSearchOutcome;

    const payload = buildSearchAuditPayload(outcome, 5);

    expect(payload.resultCount).toBe(0);
  });

  it("omits error.status when the underlying error did not carry one", () => {
    const outcome: WebSearchOutcome = {
      ok: false,
      provider: "duckduckgo",
      results: [],
      error: {
        kind: "network",
        provider: "duckduckgo",
        message: "DNS resolution failed",
      },
    };

    const payload = buildSearchAuditPayload(outcome, 4);

    expect(payload.error).toEqual({
      kind: "network",
      message: "DNS resolution failed",
    });
    expect(payload.error).not.toHaveProperty("status");
  });
});

// ---------------------------------------------------------------------------
// buildFetchAuditPayload
// ---------------------------------------------------------------------------

describe("buildFetchAuditPayload", () => {
  it("emits the always-present Requirement 5.6/5.7 fields on a minimal outcome", () => {
    const outcome: WebFetchOutcome = {
      ok: true,
      metadata: makeMinimalMetadata(),
      body: "hello",
    };

    const payload = buildFetchAuditPayload(outcome);

    expect(payload).toEqual({
      ok: true,
      requestedUrl: "https://example.com/article",
      finalUrl: "https://example.com/article",
      status: 200,
      bytesReceived: 1234,
      resolvedIp: "93.184.216.34",
      finalHostname: "example.com",
      responseMode: "readable",
      hopCount: 0,
    });
  });

  it("includes the optional TLS, timing, redirect-chain, headers and cookies blocks when produced", () => {
    const outcome: WebFetchOutcome = {
      ok: true,
      metadata: makeMinimalMetadata({
        finalUrl: "https://example.com/final",
        headers: sampleHeaders,
        tls: sampleTls,
        timing: sampleTiming,
        redirectChain: [
          { url: "https://example.com/article", status: 301, location: "/v2" },
          { url: "https://example.com/v2", status: 302, location: "/final" },
          { url: "https://example.com/final", status: 200 },
        ],
        cookies: sampleCookies,
      }),
      body: "<html>...</html>",
    };

    const payload = buildFetchAuditPayload(outcome);

    // Hop count reflects the redirect-chain length (Requirement 5.7).
    expect(payload.hopCount).toBe(3);

    // TLS subset (Requirement 5.8): the six required fields, no SANs / notBefore.
    expect(payload.tls).toEqual({
      protocol: "TLSv1.3",
      cipher: "TLS_AES_128_GCM_SHA256",
      subjectCN: "example.com",
      issuerCN: "Example CA",
      notAfter: "2030-01-01T00:00:00.000Z",
      fingerprintSha256: "ab:cd:ef:00:11:22",
    });
    expect(payload.tls).not.toHaveProperty("subjectAltNames");
    expect(payload.tls).not.toHaveProperty("notBefore");

    // Timing fields (Requirement 5.9) including tlsMs because the URL was https.
    expect(payload.timing).toEqual({
      dnsMs: 12,
      tcpMs: 34,
      tlsMs: 56,
      ttfbMs: 78,
      totalMs: 200,
    });

    // Redirect chain (Requirement 5.10): chronological, only url + status.
    expect(payload.redirectChain).toEqual([
      { url: "https://example.com/article", status: 301 },
      { url: "https://example.com/v2", status: 302 },
      { url: "https://example.com/final", status: 200 },
    ]);
    payload.redirectChain!.forEach((hop) => {
      expect(hop).not.toHaveProperty("location");
    });

    // Per-cookie metadata (Requirement 5.11): name + public attributes only.
    expect(payload.cookies).toEqual([
      {
        name: "sid",
        domain: "example.com",
        path: "/",
        httpOnly: true,
        secure: true,
        sameSite: "Lax",
      },
      {
        name: "tracker",
        domain: "ads.example.com",
        path: "/t",
        secure: false,
        sameSite: "None",
      },
    ]);

    // Cookies must NOT carry value, expires, or maxAge (Requirement 5.12).
    payload.cookies!.forEach((c) => {
      expect(c).not.toHaveProperty("value");
      expect(c).not.toHaveProperty("expires");
      expect(c).not.toHaveProperty("maxAge");
    });
  });

  it("omits tlsMs when the underlying timing did not produce one (http://)", () => {
    const outcome: WebFetchOutcome = {
      ok: true,
      metadata: makeMinimalMetadata({
        requestedUrl: "http://example.com/",
        finalUrl: "http://example.com/",
        timing: { dnsMs: 5, tcpMs: 6, ttfbMs: 7, totalMs: 20 },
      }),
      body: "hi",
    };

    const payload = buildFetchAuditPayload(outcome);

    expect(payload.timing).toEqual({
      dnsMs: 5,
      tcpMs: 6,
      ttfbMs: 7,
      totalMs: 20,
    });
    expect(payload.timing).not.toHaveProperty("tlsMs");
  });

  it("omits the redirectChain block when no redirects were captured", () => {
    const outcome: WebFetchOutcome = {
      ok: true,
      metadata: makeMinimalMetadata({ redirectChain: [] }),
      body: "ok",
    };

    const payload = buildFetchAuditPayload(outcome);

    expect(payload).not.toHaveProperty("redirectChain");
    expect(payload.hopCount).toBe(0);
  });

  it("caps redirectChain at 5 entries even when the metadata leaks more", () => {
    const synthetic = Array.from({ length: 7 }, (_, i) => ({
      url: `https://example.com/h${i}`,
      status: 301 + (i % 8),
    }));

    const outcome: WebFetchOutcome = {
      ok: true,
      metadata: makeMinimalMetadata({ redirectChain: synthetic }),
      body: "ok",
    };

    const payload = buildFetchAuditPayload(outcome);

    expect(payload.redirectChain).toHaveLength(5);
    expect(payload.redirectChain![0]).toEqual({
      url: "https://example.com/h0",
      status: 301,
    });
    expect(payload.redirectChain![4]).toEqual({
      url: "https://example.com/h4",
      status: 305,
    });
    // hopCount reflects the metadata's length (the fetch-core caps it
    // before we ever get here in production; this assertion just
    // documents that the audit helper does not re-clamp the count).
    expect(payload.hopCount).toBe(7);
  });

  it("omits the cookies block when no cookies were captured", () => {
    const outcome: WebFetchOutcome = {
      ok: true,
      metadata: makeMinimalMetadata({ cookies: [] }),
      body: "ok",
    };

    const payload = buildFetchAuditPayload(outcome);

    expect(payload).not.toHaveProperty("cookies");
  });

  it("includes the structured error block on failure outcomes", () => {
    const outcome: WebFetchOutcome = {
      ok: false,
      metadata: makeMinimalMetadata({ status: 404, bytesReceived: 0 }),
      body: "",
      error: {
        kind: "http-error",
        message: "HTTP 404 from https://example.com/article",
        status: 404,
        url: "https://example.com/article",
        bodyPreview: "Not Found",
      },
    };

    const payload = buildFetchAuditPayload(outcome);

    expect(payload.ok).toBe(false);
    expect(payload.error).toEqual({
      kind: "http-error",
      status: 404,
      message: "HTTP 404 from https://example.com/article",
    });
    // The body preview never enters the audit payload (Requirement 5.6).
    expect(JSON.stringify(payload)).not.toContain("Not Found");
  });

  // ---------------------------------------------------------------------
  // No sensitive values leak — applies to BOTH helpers per Requirements
  // 5.11, 5.12, 5.13 ("regardless of `redactSensitive`").
  // ---------------------------------------------------------------------
  it("never carries sensitive header values, cookie values, expires, or maxAge — even when redaction was off upstream", () => {
    // Headers and cookies that still carry their *raw* secret values
    // (i.e. the user disabled `redactSensitive` so the metadata never
    // got `[REDACTED]` substituted in). The audit builder must still
    // strip them by routing through `redact.stripForAudit`.
    const outcome: WebFetchOutcome = {
      ok: true,
      metadata: makeMinimalMetadata({
        headers: sampleHeaders,
        cookies: sampleCookies,
        tls: sampleTls,
        timing: sampleTiming,
        redirectChain: [
          { url: "https://example.com/article", status: 200 },
        ],
      }),
      body: "<html></html>",
    };

    const payload = buildFetchAuditPayload(outcome);

    const serialized = JSON.stringify(payload);

    // Every sentinel substring planted in the sensitive headers and
    // cookies must be absent from the serialized payload.
    expect(serialized).not.toContain(LEAK_SENTINEL);

    // Sensitive header keys are dropped entirely (not even a [REDACTED]
    // marker is kept — see redact.stripForAudit).
    expect(payload.headers).toBeDefined();
    for (const sensitive of [
      "cookie",
      "set-cookie",
      "authorization",
      "proxy-authorization",
    ]) {
      expect(payload.headers).not.toHaveProperty(sensitive);
    }

    // Non-sensitive headers pass through.
    expect(payload.headers!["content-type"]).toBe("text/html; charset=utf-8");
    expect(payload.headers!["x-frame-options"]).toBe("DENY");
  });

  it("coerces non-finite or negative numeric metadata fields defensively", () => {
    const outcome: WebFetchOutcome = {
      ok: true,
      metadata: makeMinimalMetadata({
        // Defensive: production code should already supply integers, but
        // a malformed transport must not break the audit log.
        status: 200.7 as unknown as number,
        bytesReceived: -5 as unknown as number,
      }),
      body: "ok",
    };

    const payload = buildFetchAuditPayload(outcome);

    expect(Number.isInteger(payload.status)).toBe(true);
    expect(payload.status).toBe(200);
    expect(Number.isInteger(payload.bytesReceived)).toBe(true);
    expect(payload.bytesReceived).toBe(0);
  });
});
