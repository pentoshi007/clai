import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  codexPromptCacheKey,
  codexRequestHeaders,
  encodeCodexKey,
  refreshCodexToken,
  maybeRefreshCodexCredential,
} from "../src/llm/codex-auth.js";
import { codexProvider } from "../src/llm/codex.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import { buildResponsesRequestBody } from "../src/llm/responses-http.js";

describe("Codex Parity & Cache Affinity", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("ensures session-id header and prompt_cache_key body are strictly identical in root session", () => {
    const rootSessionId = "01948523-abcd-7000-8000-000000000001";
    withSessionAffinity(rootSessionId, () => {
      const derivedKey = codexPromptCacheKey();
      expect(derivedKey).toBe(rootSessionId);

      const headers = codexRequestHeaders("acc-123");
      expect(headers["session-id"]).toBe(rootSessionId);
      expect(headers["chatgpt-account-id"]).toBe("acc-123");
      expect(headers["originator"]).toBe("codex_cli_rs");
      expect(headers["openai-beta"]).toBe("responses=experimental");
      expect(headers["x-openai-subagent"]).toBeUndefined();
    });
  });

  it("preserves identical session-id header and prompt_cache_key across multi-turn conversation", () => {
    const rootSessionId = "01948523-multi-turn-0000-000000000002";
    withSessionAffinity(rootSessionId, () => {
      const turn1Context = {
        model: "gpt-5.6-luna",
        messages: [{ role: "user" as const, content: "hello turn 1" }],
        purpose: undefined,
        reasoningEnabled: true,
      };
      const key1 = codexPromptCacheKey(turn1Context);
      const headers1 = codexRequestHeaders("acc-123", {}, undefined, key1);

      const turn2Context = {
        model: "gpt-5.6-luna",
        messages: [
          { role: "user" as const, content: "hello turn 1" },
          { role: "assistant" as const, content: "hi there" },
          { role: "user" as const, content: "hello turn 2" },
        ],
        purpose: undefined,
        reasoningEnabled: true,
      };
      const key2 = codexPromptCacheKey(turn2Context);
      const headers2 = codexRequestHeaders("acc-123", {}, undefined, key2);

      expect(key1).toBe(rootSessionId);
      expect(key2).toBe(rootSessionId);
      expect(headers1["session-id"]).toBe(rootSessionId);
      expect(headers2["session-id"]).toBe(rootSessionId);
      expect(headers1["session-id"]).toBe(key1);
      expect(headers2["session-id"]).toBe(key2);
    });
  });

  it("routes subagents to parent cache session with collab_spawn header and thread identity", () => {
    const parentSessionId = "01948523-parent-0000-8000-000000000003";
    const subagentAffinity = `${parentSessionId}:subagent:worker-analyzer`;

    withSessionAffinity(subagentAffinity, () => {
      const derivedKey = codexPromptCacheKey();
      expect(derivedKey).toBe(parentSessionId);

      const headers = codexRequestHeaders("acc-123");
      expect(headers["session-id"]).toBe(parentSessionId);
      expect(headers["thread-id"]).toBe(subagentAffinity);
      expect(headers["x-openai-subagent"]).toBe("collab_spawn");
    });
  });

  it("routes auxiliary tasks to parent cache session", () => {
    const parentSessionId = "01948523-parent-0000-8000-000000000004";
    const auxAffinity = `${parentSessionId}:auxiliary`;

    withSessionAffinity(auxAffinity, () => {
      const derivedKey = codexPromptCacheKey();
      expect(derivedKey).toBe(parentSessionId);

      const headers = codexRequestHeaders("acc-123");
      expect(headers["session-id"]).toBe(parentSessionId);
    });
  });

  it("generates deterministic matching session-id and prompt_cache_key when no session affinity exists", () => {
    const context = {
      model: "gpt-5.6-luna",
      messages: [
        { role: "system" as const, content: "You are a helpful assistant." },
        { role: "user" as const, content: "standalone query" },
      ],
      purpose: undefined,
      reasoningEnabled: false,
    };
    const key = codexPromptCacheKey(context);
    expect(key.startsWith("clai-")).toBe(true);

    const headers = codexRequestHeaders("acc-123", {}, undefined, key);
    expect(headers["session-id"]).toBe(key);
  });

  it("includes residency header when specified", () => {
    const headers = codexRequestHeaders("acc-123", {}, "us", "test-session");
    expect(headers["session-id"]).toBe("test-session");
    expect(headers["x-openai-internal-codex-residency"]).toBe("us");
  });

  it("verifies request body format matches official codex specifications", async () => {
    const sessionId = "01948523-stream-test-0000-000000000005";
    let capturedBody: any;
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = vi.fn().mockImplementation(async (url: any, init: any) => {
      if (url.includes("/responses")) {
        capturedBody = JSON.parse(init.body);
        capturedHeaders = init.headers;
        return new Response(
          'data: {"type":"response.completed","response":{"id":"resp-1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":10,"output_tokens":5,"output_token_details":{"reasoning_tokens":0}}}}\n\n',
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        );
      }
      return new Response("{}", { status: 200 });
    });

    const credential = encodeCodexKey({
      accessToken: "dummy-token",
      accountId: "acc-123",
      expiresAt: Date.now() + 3600_000,
    });

    await withSessionAffinity(sessionId, async () => {
      await codexProvider.stream(
        {
          messages: [
            { role: "system", content: "System instructions here" },
            { role: "user", content: "User prompt here" },
          ],
          model: "gpt-5.6-luna",
          thinking: { enabled: true, effort: "high" },
        },
        { apiKey: credential },
        () => {},
      );
    });

    const getHeader = (name: string): string | null => {
      if (capturedHeaders instanceof Headers) return capturedHeaders.get(name);
      return (capturedHeaders as any)[name] ?? null;
    };

    expect(capturedBody).toBeDefined();
    expect(capturedBody.model).toBe("gpt-5.6-luna");
    expect(capturedBody.instructions).toBe("System instructions here");
    expect(capturedBody.store).toBe(false);
    expect(capturedBody.include).toEqual(["reasoning.encrypted_content"]);
    expect(capturedBody.prompt_cache_key).toBe(sessionId);
    expect(getHeader("session-id")).toBe(sessionId);
    expect(getHeader("session-id")).toBe(capturedBody.prompt_cache_key);
    expect(getHeader("chatgpt-account-id")).toBe("acc-123");
  });

  it("proactively refreshes expired codex credentials before making request", async () => {
    const expiredTime = Date.now() - 10_000;
    const initialKey = encodeCodexKey({
      accessToken: "expired-token",
      refreshToken: "valid-refresh-token",
      accountId: "acc-123",
      expiresAt: expiredTime,
    });

    let refreshCalled = false;
    let requestAccessToken = "";

    globalThis.fetch = vi.fn().mockImplementation(async (url: any, init: any) => {
      if (url.includes("/oauth/token")) {
        refreshCalled = true;
        return new Response(
          JSON.stringify({
            access_token: "refreshed-token",
            refresh_token: "next-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/responses")) {
        requestAccessToken = init.headers["authorization"]?.replace("Bearer ", "");
        return new Response(
          'data: {"type":"response.completed","response":{"id":"resp-1","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hello"}]}],"usage":{"input_tokens":5,"output_tokens":2}}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("{}", { status: 200 });
    });

    await codexProvider.stream(
      {
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-5.6-luna",
      },
      { apiKey: initialKey },
      () => {},
    );

    expect(refreshCalled).toBe(true);
    expect(requestAccessToken).toBe("refreshed-token");
  });
});
