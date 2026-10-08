import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ value: "", replace: vi.fn() }));
vi.mock("../src/store/keys.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/store/keys.js")>(),
  getProviderKeys: async () => ({ keys: [{ id: "fixture-slot", value: h.value, createdAt: 0 }], activeIndex: 0, source: "fallback" as const }),
  replaceProviderKey: h.replace,
}));

beforeEach(() => {
  vi.resetModules();
  h.value = JSON.stringify({ uid: "fixture-user", accessToken: "old-access", refreshToken: "old-refresh",
    expireTime: Math.floor(Date.now() / 1000) + 3600, refreshTokenExpireTime: Math.floor(Date.now() / 1000) + 86_400,
    encryptUserInfo: "fixture-info", key: "fixture-key", machineId: "fixture-machine", machineToken: "fixture-token" });
  h.replace.mockReset().mockImplementation(async (_provider: string, old: string, fresh: string) => {
    if (h.value !== old) return false;
    h.value = fresh;
    return true;
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function sse(body: object, status = 200): Response {
  return new Response(`data: ${JSON.stringify({ statusCodeValue: status, body: JSON.stringify(body) })}\n\n`);
}

function refreshed(): Response {
  return new Response(JSON.stringify({ device_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }));
}

describe("Qoder credential refresh during queue recovery", () => {
  it("refreshes an expired queue-poll credential without losing the queued request identity", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let polls = 0;
    let inferences = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith("/deviceToken/refresh")) return refreshed();
      if (url.includes("/queue/status?")) return polls++ === 0
        ? new Response('{"message":"access token expired"}', { status: 401 })
        : new Response('{"isQueued":false}');
      if (url.includes("/ask/finish?")) return new Response("{}");
      return inferences++ === 0
        ? sse({ code: "10605", message: JSON.stringify({ isQueued: true, modelKey: "qfmodel", queueType: "p3" }) }, 403)
        : sse({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] });
    }));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    const { QoderSigner } = await import("../src/llm/qoder/qoder-signer.js");
    const signedInference = vi.spyOn(QoderSigner.prototype, "prepareInfer");
    const auth = { apiKey: h.value };
    const result = await qoderProvider.stream!({ model: "qfmodel:free", messages: [{ role: "user", content: "hi" }] }, auth, () => {});
    expect(result.text).toBe("answer");
    expect(polls).toBe(2);
    expect(inferences).toBe(2);
    expect(h.replace).toHaveBeenCalledOnce();
    expect(JSON.parse(auth.apiKey)).toMatchObject({ accessToken: "fresh-access", refreshToken: "fresh-refresh" });
    const inferenceBodies = signedInference.mock.calls.map(([request]) => JSON.parse(request.body));
    const requestSetId = inferenceBodies[0]!.request_set_id;
    expect(inferenceBodies[1]!.request_set_id).toBe(requestSetId);
    const pollSets = calls.filter(({ url }) => url.includes("/queue/status?")).map(({ url }) => new URL(url).searchParams.get("requestSetId"));
    expect(pollSets).toEqual([requestSetId, requestSetId]);
  });

  it("refreshes an actual HTTP inference rejection once before streaming", async () => {
    let inferences = 0;
    let refreshes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/deviceToken/refresh")) { refreshes++; return refreshed(); }
      return inferences++ === 0 ? new Response('{"message":"access token expired"}', { status: 403 })
        : sse({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] });
    }));
    const { qoderProvider } = await import("../src/llm/qoder/qoder.js");
    expect((await qoderProvider.complete({ model: "qfmodel:free", messages: [{ role: "user", content: "hi" }] }, { apiKey: h.value })).text).toBe("answer");
    expect(refreshes).toBe(1);
    expect(inferences).toBe(2);
  });
});
