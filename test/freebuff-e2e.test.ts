import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pollFreebuffDeviceAuth,
  startFreebuffDeviceAuth,
  validateFreebuffToken,
} from "../src/llm/freebuff-auth.js";
import { freebuffProvider } from "../src/llm/freebuff.js";
import {
  disposeFreebuffSessionManager,
  runFreebuffSessionShutdownCleanup,
} from "../src/llm/freebuff-session.js";
import { resetFreebuffCatalogCache } from "../src/llm/freebuff-models.js";
import type { CompletionRequest } from "../src/types.js";

const TOKEN = "freebuff-e2e-opaque-token-987654321";
const MODEL = "vendor/e2e-model";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sse(): Response {
  const frames = [
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: { role: "assistant", content: "integration " }, finish_reason: null }],
      usage: null,
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: { content: "passed" }, finish_reason: null }],
      usage: null,
    })}\n\n`,
    `data: ${JSON.stringify({
      id: "chatcmpl-e2e",
      object: "chat.completion.chunk",
      model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: null,
    })}\n\n`,
    "data: [DONE]\n\n",
  ];
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function request(): CompletionRequest {
  return {
    provider: "freebuff",
    model: MODEL,
    messages: [{ role: "user", content: "Run the integration fixture." }],
  };
}

afterEach(async () => {
  await disposeFreebuffSessionManager();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetFreebuffCatalogCache();
});

describe("Freebuff mocked login-to-catalog integration", () => {
  it("authenticates, discovers a visible model, and streams under a released claim", async () => {
    const challengeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      json(200, {
        loginUrl: "https://freebuff.com/login?code=fixture",
        fingerprintHash: "fingerprint-hash",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }),
    );
    const challenge = await startFreebuffDeviceAuth(
      { fingerprintId: "codebuff-cli-e2e" },
      { fetch: challengeFetch },
    );
    expect(challengeFetch.mock.calls[0]![0]).toBe("https://freebuff.com/api/auth/cli/code");

    let pollCount = 0;
    const pollFetch = vi.fn<typeof fetch>().mockImplementation(async () => {
      pollCount += 1;
      return pollCount === 1
        ? json(401, { error: "pending" })
        : json(200, { user: { id: "fixture-user", authToken: TOKEN } });
    });
    const login = await pollFreebuffDeviceAuth(
      challenge,
      {},
      { fetch: pollFetch, sleep: async () => undefined, now: () => 0 },
    );
    expect(login.token).toBe(TOKEN);
    expect(pollFetch).toHaveBeenCalledTimes(2);

    const identityFetch = vi.fn<typeof fetch>().mockResolvedValue(json(200, { id: "fixture-user" }));
    await validateFreebuffToken(login.token, {}, { fetch: identityFetch });
    expect(new URL(String(identityFetch.mock.calls[0]![0])).pathname).toBe("/api/v1/me");
    expect(new URL(String(identityFetch.mock.calls[0]![0])).searchParams.get("fields")).toBe("id,email");

    const calls: Array<{
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: Record<string, unknown>;
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : String(input);
        const headers = Object.fromEntries(new Headers(init?.headers).entries());
        const body = typeof init?.body === "string"
          ? JSON.parse(init.body) as Record<string, unknown>
          : undefined;
        const method = init?.method ?? "GET";
        calls.push({ url, method, headers, ...(body ? { body } : {}) });

        if (url.endsWith("/api/v1/freebuff/session/admission")) {
          return json(200, {
            status: "active",
            instanceId: "cli:e2e-instance",
            model: MODEL,
            remainingMs: 3_600_000,
          });
        }
        if (url.endsWith("/api/v1/freebuff/session")) {
          return json(200, {
            status: "none",
            rateLimitsByModel: { [MODEL]: {} },
          });
        }
        if (url.endsWith("/chat/completions")) return sse();
        if (url.endsWith("/api/v1/agent-runs")) return json(200, { runId: "e2e-run" });
        if (url.endsWith("/api/v1/freebuff/session/attempt")) return json(200, { status: "ended" });
        return json(404, { error: "unexpected endpoint" });
      }),
    );

    const models = await freebuffProvider.listModels!({ apiKey: login.token });
    expect(models).toContain(MODEL);
    const completion = await freebuffProvider.stream!(
      request(),
      { apiKey: login.token },
      () => {},
    );
    expect(completion.text).toBeTruthy();

    const probe = calls.find((call) => call.method === "GET")!;
    expect(probe.url).toBe("https://www.codebuff.com/api/v1/freebuff/session");
    expect(probe.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls.some((call) => call.url.includes("/session/admission"))).toBe(true);
    const chat = calls.find((call) => call.url.endsWith("/chat/completions"))!;
    expect(chat.body).toMatchObject({
      codebuff_metadata: { run_id: "e2e-run", freebuff_instance_id: "cli:e2e-instance" },
    });

    let epilogueRan = false;
    await runFreebuffSessionShutdownCleanup(async () => {
      epilogueRan = true;
    });
    expect(
      calls.some(
        (call) =>
          call.method === "DELETE" && call.url.endsWith("/api/v1/freebuff/session/attempt"),
      ),
    ).toBe(true);
    expect(epilogueRan).toBe(true);
  });
});
