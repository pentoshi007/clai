import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { httpFetch } from "../../src/tools/http.js";
import { securityLabBody, securityLabLargeBody, startTokenSecurityLab } from "../../scripts/token-security-lab.js";

let lab: Awaited<ReturnType<typeof startTokenSecurityLab>>;
beforeAll(async () => { lab = await startTokenSecurityLab(); });
afterAll(async () => { await lab?.close(); });
const digest = (body: string) => createHash("sha256").update(body).digest("hex");

describe("synthetic security evidence gate fixtures", () => {
  it("S01 captures raw hidden/comment/header evidence and rejects readable-only substitution", async () => {
    const raw = await httpFetch(`${lab.url}/raw`, { iOwnThis: true, retries: 0 });
    expect(raw.ok).toBe(true);
    expect(raw.output).toContain("<!-- SYNTHETIC_EVIDENCE_S01 -->");
    expect(raw.output).toContain('data-lab="SYNTHETIC_ATTRIBUTE"');
    expect(raw.output).toContain("x-lab-evidence: SYNTHETIC_HEADER");
    expect(raw.output).toContain(`bodySha256=${digest(securityLabBody)}`);
    const readable = await httpFetch(`${lab.url}/raw`, { iOwnThis: true, responseMode: "readable", retries: 0 });
    expect(readable.output).not.toContain("<!-- SYNTHETIC_EVIDENCE_S01 -->");
  });

  it.each([false, true])("S02 retains redirects and repeated cookies with explicit credential-forwarding=%s", async (forwardSensitiveHeaders) => {
    const before = lab.requests.length;
    const result = await httpFetch(`${lab.url}/redirect`, { iOwnThis: true, retries: 0, forwardSensitiveHeaders,
      headers: { Authorization: "Bearer synthetic-not-secret", Cookie: "fixture=synthetic" } });
    expect(result.ok).toBe(true);
    for (const value of ["302", "200", "first-a=synthetic", "first-b=synthetic", "second-a=synthetic", "second-b=synthetic", "SYNTHETIC_FIRST_HOP", "SYNTHETIC_REDIRECT_FINAL"]) expect(result.output).toContain(value);
    expect(lab.requests.slice(before)).toEqual([
      { path: "/redirect", origin: "primary", authorizationPresent: true, cookiePresent: true },
      { path: "/final", origin: "secondary", authorizationPresent: forwardSensitiveHeaders, cookiePresent: forwardSensitiveHeaders },
    ]);
  });

  it.each([401, 403, 404, 500])("S03 preserves real %s status/body and does not silently retry", async (status) => {
    const before = lab.requests.length;
    const result = await httpFetch(`${lab.url}/status/${status}`, { iOwnThis: true, retries: 0 });
    expect(result.output).toContain(`${status} `);
    expect(result.output).toContain(`SYNTHETIC_STATUS_${status}`);
    expect(lab.requests.length - before).toBe(1);
  });

  it("S05 distinguishes capture/display bounds and hashes captured decoded bytes", async () => {
    const partial = await httpFetch(`${lab.url}/compressed`, { iOwnThis: true, retries: 0, maxBytes: 1024 });
    expect(partial.output).toContain("truncated@1024");
    expect(partial.output).toContain(`bodySha256=${digest(securityLabLargeBody.slice(0, 1024))}`);
    expect(partial.output).toContain("EARLY_EVIDENCE");
    expect(partial.output).not.toContain("LATE_EVIDENCE");
    const complete = await httpFetch(`${lab.url}/compressed`, { iOwnThis: true, retries: 0, maxBytes: 16_384 });
    expect(complete.output).toContain("LATE_EVIDENCE");
    expect(complete.output).toContain(`bodySha256=${digest(securityLabLargeBody)}`);
    expect(complete.output).not.toContain("truncated@");
  });

  it("S06 supplies a known authorization flaw and a patched negative-control endpoint", async () => {
    const vulnerable = await httpFetch(`${lab.url}/vulnerable?owner=other`, { iOwnThis: true, retries: 0 });
    const patched = await httpFetch(`${lab.url}/patched?owner=other`, { iOwnThis: true, retries: 0 });
    const missing = await httpFetch(`${lab.url}/nonexistent`, { iOwnThis: true, retries: 0 });
    expect(vulnerable.output).toMatch(/200 .*GET/);
    expect(vulnerable.output).toContain("SYNTHETIC_OTHER_OWNER_DOCUMENT");
    expect(patched.output).toMatch(/403 .*GET/);
    expect(patched.output).not.toContain("SYNTHETIC_OTHER_OWNER_DOCUMENT");
    expect(missing.output).toMatch(/404 .*GET/);
    expect(missing.output).toContain("SYNTHETIC_NOT_FOUND_BASELINE");
  });
});
