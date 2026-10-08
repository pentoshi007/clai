import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { completeWithProvider, streamWithProvider } from "../src/llm/router.js";
import { classifyStreamFailure, createStreamRecoveryState, planStreamRecovery } from "../src/agent/stream-recovery.js";
import { isRetriableError } from "../src/llm/routing/error-classification.js";

const h = vi.hoisted(() => ({ keyCount: 2 }));
vi.mock("../src/store/keys.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/store/keys.js")>(),
  getProviderKeys: async (provider: string) => ({
    keys: provider === "qoder" ? Array.from({ length: h.keyCount }, (_, index) => ({
      id: `fixture-slot-${index}`, createdAt: 0,
      value: JSON.stringify({ uid: `fixture-${index}`, accessToken: "fixture", expireTime: 4_000_000_000,
        encryptUserInfo: "fixture", key: "fixture", machineId: "fixture", machineToken: "fixture" }),
    })) : [],
    activeIndex: 0, source: "env" as const,
  }),
}));
vi.mock("../src/llm/qoder/qoder-signer.js", () => ({
  QoderSigner: {
    create: async () => ({
      prepareInfer: ({ body }: { body: string }) => ({ url: "https://test.invalid/inference", headers: {}, body }),
      prepare: ({ endpoint, path, body }: { endpoint: string; path: string; body?: string }) => ({ url: `${endpoint}${path}`, headers: {}, body }),
      free: () => {},
    }),
  },
}));

const request = { provider: "qoder" as const, model: "qfmodel:free", messages: [{ role: "user" as const, content: "hi" }] };
const queued = { isQueued: true, serviceAvailable: false, retryAfterSeconds: 30, modelKey: "qfmodel", queueType: "p3" };
const body = JSON.stringify({ code: "403", message: JSON.stringify({ code: "10605", message: JSON.stringify(queued) }) });
function inference(text?: string) {
  const raw = text ? JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] }) : body;
  return new Response(`data: ${JSON.stringify({ body: raw, statusCodeValue: text ? 200 : 403 })}\n\n`);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Qoder queue retry ownership through the router", () => {
  it.each(["stream", "complete"] as const)("recovers queued %s requests on the selected account", async (mode) => {
    let inferences = 0;
    const bodies: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("/queue/status?")) return new Response('{"isQueued":false}');
      if (String(input).includes("/ask/finish?")) return new Response("{}");
      bodies.push(String(init?.body));
      return inference(inferences++ === 0 ? undefined : "answer");
    });
    vi.stubGlobal("fetch", fetcher);
    const onToken = vi.fn();
    const onKeyEvent = vi.fn();
    const options = { onStatus: vi.fn(), onKeyEvent, allowProviderFallback: false };
    const result = mode === "stream" ? await streamWithProvider(request, onToken, options) : await completeWithProvider(request, options);
    expect(result).toMatchObject({ text: "answer", provider: "qoder" });
    expect(inferences).toBe(2);
    expect(JSON.parse(bodies[0]!).request_set_id).toBe(JSON.parse(bodies[1]!).request_set_id);
    expect(onKeyEvent.mock.calls.some(([event]) => event.type === "switch")).toBe(false);
    if (mode === "stream") expect(onToken).toHaveBeenCalledExactlyOnceWith("answer");
  });

  it("does not restart an exhausted queue in key rotation or agent recovery", async () => {
    vi.stubEnv("QODER_MODEL_QUEUE_MAX_WAIT_MS", "1000");
    let inferences = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("/queue/status?")) return new Response(JSON.stringify(queued));
      if (String(input).includes("/ask/finish?")) return new Response("{}");
      inferences++;
      return inference();
    });
    vi.stubGlobal("fetch", fetcher);
    const events = vi.fn();
    const outcome = streamWithProvider(request, () => {}, { onStatus: () => {}, onKeyEvent: events, allowProviderFallback: false })
      .catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const error = await outcome;
    expect(error).toMatchObject({ retryable: false });
    expect(isRetriableError(error)).toBe(false);
    expect(classifyStreamFailure(error)).toBe("non-retriable");
    expect(planStreamRecovery({ error, state: createStreamRecoveryState() }).action).toBe("give-up");
    expect(inferences).toBe(1);
    expect(events.mock.calls.some(([event]) => event.type === "retry" || event.type === "switch")).toBe(false);
  });
});
