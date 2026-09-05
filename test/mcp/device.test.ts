import { describe, expect, it, vi } from "vitest";
import {
  pollDeviceTokens,
  requestDeviceAuthorization,
} from "../../src/mcp/auth/device.js";
import { McpTransportError } from "../../src/mcp/transport.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("requestDeviceAuthorization", () => {
  it("parses a device authorization response", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        device_code: "dc",
        user_code: "ABCD-EFGH",
        verification_uri: "https://example.com/device",
        verification_uri_complete: "https://example.com/device?code=ABCD-EFGH",
        interval: 1,
        expires_in: 600,
      }),
    );
    const result = await requestDeviceAuthorization(
      {
        deviceAuthorizationEndpoint: "https://example.com/device/code",
        clientId: "client",
        scope: "read",
      },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.deviceCode).toBe("dc");
    expect(result.userCode).toBe("ABCD-EFGH");
    expect(result.verificationUriComplete).toContain("code=");
    const body = new URLSearchParams(
      String((fetchImpl.mock.calls[0] as unknown[])[1] && ((fetchImpl.mock.calls[0] as [unknown, RequestInit])[1].body)),
    );
    expect(body.get("client_id")).toBe("client");
    expect(body.get("scope")).toBe("read");
  });

  it("throws a useful error when the endpoint rejects", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "unauthorized_client", error_description: "no device flow" }, 400),
    );
    await expect(
      requestDeviceAuthorization(
        { deviceAuthorizationEndpoint: "https://example.com/device/code", clientId: "c" },
        { fetchImpl: fetchImpl as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/no device flow/);
  });
});

describe("pollDeviceTokens", () => {
  const base = {
    tokenEndpoint: "https://example.com/token",
    deviceCode: "dc",
    clientId: "client",
    intervalSeconds: 1,
    expiresInSeconds: 60,
  };

  it("polls through authorization_pending until success", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return jsonResponse({ error: "authorization_pending" }, 400);
      return jsonResponse({ access_token: "AT", token_type: "bearer", expires_in: 10 });
    });
    const sleeps: number[] = [];
    const token = await pollDeviceTokens(base, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(token.accessToken).toBe("AT");
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(3);
  });

  it("honors slow_down by increasing the interval", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "slow_down" }, 400);
      return jsonResponse({ access_token: "AT", token_type: "bearer" });
    });
    const sleeps: number[] = [];
    await pollDeviceTokens(base, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
  });

  it("fails cleanly on access_denied and expired_token", async () => {
    const denied = vi.fn(async () => jsonResponse({ error: "access_denied" }, 400));
    await expect(
      pollDeviceTokens(base, {
        fetchImpl: denied as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/declined/);

    const expired = vi.fn(async () => jsonResponse({ error: "expired_token" }, 400));
    await expect(
      pollDeviceTokens(base, {
        fetchImpl: expired as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(McpTransportError);
  });
});
