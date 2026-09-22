import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLINE_API_BASE_URL,
  CLINE_WORKOS_API_BASE_URL,
  pollClineDeviceAuth,
  refreshClineToken,
  maybeRefreshClineToken,
  registerWorkOSTokensWithCline,
  candidateClineCredentialPaths,
} from "../src/llm/cline-auth.js";
import { clineProvider } from "../src/llm/cline.js";
import { buildChatBody } from "../src/llm/wire/chat-body.js";

describe("Cline parity and prompt caching", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("registers WorkOS tokens with Cline backend during device code completion", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "workos_access_123",
            refresh_token: "workos_refresh_123",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              accessToken: "cline_jwt_token_456",
              refreshToken: "cline_refresh_token_456",
              expiresAt: "2030-01-01T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await pollClineDeviceAuth({
      deviceCode: "code-1",
      userCode: "USER-1",
      verificationUrl: "https://auth.cline.bot",
      expiresInSeconds: 300,
      pollIntervalSeconds: 1,
    });

    expect(tokens.accessToken).toBe("workos:cline_jwt_token_456");
    expect(tokens.refreshToken).toBe("cline_refresh_token_456");
    expect(tokens.expiresAt).toBe(Date.parse("2030-01-01T00:00:00.000Z"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${CLINE_WORKOS_API_BASE_URL}/user_management/authenticate`);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${CLINE_API_BASE_URL}/auth/register`);
  });

  it("refreshes tokens via Cline /auth/refresh endpoint first", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            accessToken: "cline_jwt_refreshed_789",
            refreshToken: "cline_refresh_next_789",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshClineToken("cline_refresh_token_old");
    expect(result.accessToken).toBe("workos:cline_jwt_refreshed_789");
    expect(result.refreshToken).toBe("cline_refresh_next_789");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${CLINE_API_BASE_URL}/auth/refresh`);
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(sentBody).toEqual({
      refreshToken: "cline_refresh_token_old",
      grantType: "refresh_token",
    });
  });

  it("falls back to WorkOS authenticate when Cline /auth/refresh fails and re-registers", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "workos_fresh_access",
            refresh_token: "workos_fresh_refresh",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            success: true,
            data: {
              accessToken: "cline_reregistered_access",
              refreshToken: "cline_reregistered_refresh",
              expiresAt: "2030-01-01T00:00:00.000Z",
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await refreshClineToken("workos_refresh_token");
    expect(result.accessToken).toBe("workos:cline_reregistered_access");
    expect(result.refreshToken).toBe("cline_reregistered_refresh");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${CLINE_API_BASE_URL}/auth/refresh`);
    expect(fetchMock.mock.calls[1]![0]).toBe(`${CLINE_WORKOS_API_BASE_URL}/user_management/authenticate`);
    expect(fetchMock.mock.calls[2]![0]).toBe(`${CLINE_API_BASE_URL}/auth/register`);
  });

  it("refreshes keys regardless of whether they have a workos: prefix", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          success: true,
          data: {
            accessToken: "new_plain_jwt",
            refreshToken: "new_refresh",
            expiresAt: "2030-01-01T00:00:00.000Z",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await maybeRefreshClineToken("custom_imported_api_key_without_prefix", "valid_refresh_token");
    expect(result).toBeDefined();
    expect(result?.accessToken).toBe("workos:new_plain_jwt");
  });

  it("applies prompt caching cache_control and session_id for Claude models in chat completions body", () => {
    const body = buildChatBody({
      model: "anthropic/claude-sonnet-4.6",
      providerId: "cline",
      messages: [
        { role: "system", content: "You are a concise assistant." },
        { role: "user", content: "Hello world" },
      ],
      stream: true,
    });

    const parsed = JSON.parse(body);
    expect(parsed.cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.messages[1].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.session_id).toBeDefined();
  });

  it("applies prompt caching cache_control and session_id for Qwen models in chat completions body", () => {
    const body = buildChatBody({
      model: "qwen/qwen-2.5-coder-32b",
      providerId: "cline",
      messages: [
        { role: "system", content: "You are a coding helper." },
        { role: "user", content: "Write quicksort" },
      ],
      stream: true,
    });

    const parsed = JSON.parse(body);
    expect(parsed.cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.messages[1].cache_control).toEqual({ type: "ephemeral" });
    expect(parsed.session_id).toBeDefined();
  });

  it("does not inject cache_control for DeepSeek models but retains session_id", () => {
    const body = buildChatBody({
      model: "cline-free/deepseek-v4.1-flash",
      providerId: "cline",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Explain recursion" },
      ],
      stream: true,
    });

    const parsed = JSON.parse(body);
    expect(parsed.cache_control).toBeUndefined();
    expect(parsed.messages[1].cache_control).toBeUndefined();
    expect(parsed.session_id).toBeDefined();
  });

  it("includes CLINE_DATA_DIR in candidate credential paths when set", () => {
    const oldEnv = process.env.CLINE_DATA_DIR;
    try {
      process.env.CLINE_DATA_DIR = "/custom/cline/dir";
      const paths = candidateClineCredentialPaths();
      expect(paths).toContain("/custom/cline/dir/settings/providers.json");
    } finally {
      process.env.CLINE_DATA_DIR = oldEnv;
    }
  });

  it("sends X-Task-ID header with completions request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "res-1",
          choices: [{ message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await clineProvider.complete!(
      {
        provider: "cline",
        model: "cline-free/deepseek-v4.1-flash",
        messages: [{ role: "user", content: "ping" }],
      },
      { apiKey: "workos:test-token-valid-length-12345" },
    );

    expect(fetchMock).toHaveBeenCalled();
    const headers = fetchMock.mock.calls[0]![1].headers;
    expect(headers["X-Task-ID"]).toBeDefined();
    expect(typeof headers["X-Task-ID"]).toBe("string");
    expect(headers["User-Agent"]).toMatch(/^Cline\//);
    expect(headers["X-CLIENT-TYPE"]).toBe("cline-desktop");
  });
});
