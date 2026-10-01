import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OmnirushAuthError,
  importExistingOmnirushAuth,
  omnirushGatewayUrl,
  omnirushManagerUserAgent,
  pollOmnirushDeviceAuth,
  refreshOmnirushToken,
  startOmnirushDeviceAuth,
  verifyOmnirushToken,
  type OmnirushDeviceAuthStart,
} from "../src/llm/omnirush-auth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const authorizePayload = {
  device_code: "dev-code-1",
  user_code: "9KYC-U6C7",
  verification_uri: "https://omnirush.ai/console",
  verification_uri_complete: "https://omnirush.ai/console?code=9KYC-U6C7",
  expires_in: 600,
  interval: 1,
};

function approvedPayload(): Record<string, unknown> {
  return {
    access_token: "omnirush-access-1",
    refresh_token: "omr_refresh_1",
    gateway_url: "https://omnirush.ai/omnirush/v1",
  };
}

describe("omnirush device auth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.OMNIRUSH_DIR;
    delete process.env.OMNIRUSH_ORIGIN;
    delete process.env.OMNIRUSH_GATEWAY_URL;
  });

  it("starts a device authorization against the manager origin", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(authorizePayload));
    vi.stubGlobal("fetch", fetchMock);

    const start = await startOmnirushDeviceAuth();

    expect(start.deviceCode).toBe("dev-code-1");
    expect(start.userCode).toBe("9KYC-U6C7");
    expect(start.verificationUrlComplete).toBe(
      "https://omnirush.ai/console?code=9KYC-U6C7",
    );
    expect(start.expiresInSeconds).toBe(600);
    expect(start.pollIntervalSeconds).toBe(1);

    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://omnirush.ai/omnirush/device/authorize");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/^omnirush\/\d+\.\d+\.\d+ \(/);
    const body = JSON.parse(String(init.body));
    expect(body.platform).toBe(process.platform);
    expect(typeof body.device_name).toBe("string");
    expect(body.device_name.length).toBeGreaterThan(0);
  });

  it("polls through authorization_pending (428) until approved", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ detail: "authorization_pending" }, 428))
      .mockResolvedValueOnce(jsonResponse({ detail: "authorization_pending" }, 428))
      .mockResolvedValueOnce(jsonResponse(approvedPayload()));
    vi.stubGlobal("fetch", fetchMock);

    const start: OmnirushDeviceAuthStart = {
      deviceCode: "dev-code-1",
      userCode: "9KYC-U6C7",
      verificationUrl: "https://omnirush.ai/console",
      verificationUrlComplete: "https://omnirush.ai/console?code=9KYC-U6C7",
      expiresInSeconds: 600,
      pollIntervalSeconds: 1,
    };

    const tokens = await pollOmnirushDeviceAuth(start, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(tokens.accessToken).toBe("omnirush-access-1");
    expect(tokens.refreshToken).toBe("omr_refresh_1");
    expect(tokens.gatewayUrl).toBe("https://omnirush.ai/omnirush");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe("https://omnirush.ai/omnirush/device/token");
      expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
        device_code: "dev-code-1",
      });
    }
  });

  it("fails the poll when the code expires", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ detail: "expired_token" }, 400),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      pollOmnirushDeviceAuth(
        {
          deviceCode: "dev-code-1",
          userCode: "9KYC-U6C7",
          verificationUrl: "https://omnirush.ai/console",
          verificationUrlComplete: "https://omnirush.ai/console?code=9KYC-U6C7",
          expiresInSeconds: 600,
          pollIntervalSeconds: 1,
        },
        { fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/expired/i);
  });

  it("rotates both tokens on refresh", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: "omnirush-access-2",
        refresh_token: "omr_refresh_2",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshOmnirushToken("omr_refresh_1", fetchMock as unknown as typeof fetch);

    expect(tokens).toEqual({
      accessToken: "omnirush-access-2",
      refreshToken: "omr_refresh_2",
    });
    const call = fetchMock.mock.calls[0]!;
    expect(String(call[0])).toBe("https://omnirush.ai/omnirush/device/refresh");
    expect(JSON.parse(String((call[1] as RequestInit).body))).toEqual({
      refresh_token: "omr_refresh_1",
    });
  });

  it("reports a rejected refresh as an invalid grant", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ detail: "refresh_token_invalid_or_expired" }, 401),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await refreshOmnirushToken(
      "omr_refresh_dead",
      fetchMock as unknown as typeof fetch,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(OmnirushAuthError);
    expect((error as OmnirushAuthError).isLikelyInvalidGrant()).toBe(true);
  });

  it("verifies a token via /device/me", async () => {
    const okFetch = vi.fn(async () => jsonResponse({ email: "user@example.com" }));
    vi.stubGlobal("fetch", okFetch);
    expect(await verifyOmnirushToken("omnirush-access-1", okFetch as unknown as typeof fetch)).toBe(true);
    expect(String(okFetch.mock.calls[0]![0])).toBe("https://omnirush.ai/omnirush/device/me");

    const unauthorized = vi.fn(async () => jsonResponse({ detail: "device_token_invalid" }, 401));
    expect(await verifyOmnirushToken("stale", unauthorized as unknown as typeof fetch)).toBe(false);
  });

  it("imports credentials from the omnirush CLI state dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omnirush-import-"));
    try {
      process.env.OMNIRUSH_DIR = dir;
      writeFileSync(
        join(dir, "auth.json"),
        JSON.stringify({
          accessToken: "omnirush-access-1",
          refreshToken: "omr_refresh_1",
          gatewayUrl: "https://omnirush.ai/omnirush",
          savedAt: "2026-10-01T10:04:49.100Z",
        }),
      );

      const imported = await importExistingOmnirushAuth();
      expect(imported).toEqual({
        accessToken: "omnirush-access-1",
        refreshToken: "omr_refresh_1",
        gatewayUrl: "https://omnirush.ai/omnirush",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined when no omnirush credential file exists", async () => {
    process.env.OMNIRUSH_DIR = mkdtempSync(join(tmpdir(), "omnirush-empty-"));
    expect(await importExistingOmnirushAuth()).toBeUndefined();
  });

  it("honors OMNIRUSH_GATEWAY_URL for the gateway base", () => {
    process.env.OMNIRUSH_GATEWAY_URL = "https://gateway.example.com/v1";
    expect(omnirushGatewayUrl()).toBe("https://gateway.example.com/v1");
    delete process.env.OMNIRUSH_GATEWAY_URL;
    process.env.OMNIRUSH_ORIGIN = "https://origin.example.com/omnirush";
    expect(omnirushGatewayUrl()).toBe("https://origin.example.com/omnirush/v1");
  });

  it("builds the manager user agent from the CLI version", () => {
    expect(omnirushManagerUserAgent()).toMatch(
      /^omnirush\/\d+\.\d+\.\d+ \([a-z0-9]+; [a-z0-9]+\)$/,
    );
  });
});
