import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hostname } from "node:os";
import { qoderProvider } from "../src/llm/qoder/qoder.js";
import { isAuthKeyError } from "../src/llm/key-rotation.js";
import { isRetriableError } from "../src/llm/routing/error-classification.js";
import { formatProviderFailureForUser } from "../src/llm/routing/failure-report.js";

vi.mock("../src/llm/qoder/qoder-signer.js", () => ({
  QoderSigner: {
    create: async () => ({
      prepareInfer: ({ body }: { body: string }) => ({ url: "https://test.invalid/inference", headers: {}, body }),
      prepare: ({ endpoint, path, body }: { endpoint: string; path: string; body?: string }) => ({
        url: `${endpoint}${path}`, headers: { Connection: "keep-alive", "Content-Length": "0" }, body,
      }),
      free: () => {},
    }),
  },
}));

const credential = {
  uid: "fixture-user", accessToken: "fixture-access", expireTime: 4_000_000_000,
  encryptUserInfo: "fixture-info", key: "fixture-key", machineId: "fixture-machine", machineToken: "fixture-token",
};
const request = { model: "qfmodel:free", messages: [{ role: "user" as const, content: "question" }] };
const queue = { isQueued: true, modelKey: "qfmodel", queueCount: 0, queueType: "p3", retryAfterSeconds: 30, serviceAvailable: false, waitTime: 30 };
const queueBody = JSON.stringify({ code: "403", message: JSON.stringify({ code: "10605", message: JSON.stringify(queue) }) });

function sse(body: object | string, statusCodeValue = 200): Response {
  return new Response(`data: ${JSON.stringify({ statusCodeValue, body: typeof body === "string" ? body : JSON.stringify(body) })}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function answer(): Response {
  return sse({ choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] });
}

function setup(initial: () => Response = () => sse(queueBody, 403), statuses: object[] = [{ isQueued: false }]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let inferenceCount = 0;
  let polls = 0;
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes("/queue/status?")) return new Response(JSON.stringify(statuses[Math.min(polls++, statuses.length - 1)]));
    if (url.includes("/ask/finish?")) return new Response("{}");
    return inferenceCount++ === 0 ? initial() : answer();
  });
  vi.stubGlobal("fetch", fetcher);
  const auth = { apiKey: JSON.stringify(credential) };
  const onStatus = vi.fn();
  const onToken = vi.fn();
  return { calls, fetcher, auth, onStatus, onToken,
    run: () => qoderProvider.stream!({ ...request }, auth, onToken, onStatus),
    inferences: () => calls.filter(({ url }) => url.endsWith("/inference")),
    polls: () => calls.filter(({ url }) => url.includes("/queue/status?")),
    finishes: () => calls.filter(({ url }) => url.includes("/ask/finish?")),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Qoder model queue recovery", () => {
  it.each(["stream", "complete"] as const)("recovers the exact nested 403 for %s without changing accounts", async (mode) => {
    const h = setup();
    const result = mode === "stream"
      ? await qoderProvider.stream!(request, h.auth, h.onToken, h.onStatus)
      : await qoderProvider.complete(request, h.auth, h.onStatus);
    expect(result.text).toBe("answer");
    expect(h.inferences()).toHaveLength(2);
    expect(h.polls()).toHaveLength(1);
    expect(h.finishes()).toHaveLength(1);
    const first = JSON.parse(String(h.inferences()[0]!.init?.body));
    const second = JSON.parse(String(h.inferences()[1]!.init?.body));
    expect(second.request_set_id).toBe(first.request_set_id);
    expect(second.session_id).toBe(first.session_id);
    expect(second.request_id).not.toBe(first.request_id);
    expect(second.chat_record_id).toBe(second.request_id);
    const poll = new URL(h.polls()[0]!.url);
    expect(poll.origin).toBe("https://api1.qoder.sh");
    expect(poll.searchParams.get("requestSetId")).toBe(first.request_set_id);
    expect(poll.searchParams.get("modelKey")).toBe("qfmodel");
    expect(poll.searchParams.get("queueType")).toBe("p3");
    const headers = new Headers(h.polls()[0]!.init?.headers);
    expect(headers.get("Cosy-MachineToken")).toBe(credential.machineToken);
    expect(headers.get("Cosy-MachineHostname")).toBe(hostname());
    expect(headers.get("X-Request-ID")).toBe(first.request_id);
    expect(headers.get("X-Session-ID")).toBe(first.session_id);
    expect(headers.has("Content-Length")).toBe(false);
    expect(h.auth.apiKey).toBe(JSON.stringify(credential));
    const finish = JSON.parse(String(h.finishes()[0]!.init?.body));
    expect(JSON.parse(finish.payload)).toMatchObject({ model_key: "qfmodel", request_set_id: first.request_set_id, user_id: credential.uid });
  });

  it("recognizes queue bodies on actual HTTP 403 responses", async () => {
    const h = setup(() => new Response(queueBody, { status: 403 }));
    expect((await h.run()).text).toBe("answer");
    expect(h.polls()).toHaveLength(1);
  });

  it("polls a bare 10605 response without queue metadata", async () => {
    const h = setup(() => sse({ code: "10605", message: "Model busy" }, 403));
    expect((await h.run()).text).toBe("answer");
    expect(new URL(h.polls()[0]!.url).searchParams.get("modelKey")).toBe("qfmodel");
  });

  it("keeps polling an unavailable service and respects polling and readiness delays", async () => {
    const h = setup(undefined, [{ data: JSON.stringify(queue) }, { result: { isQueued: false, retryAfterSeconds: 2 } }]);
    const pending = h.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.polls()).toHaveLength(1);
    expect(h.inferences()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.polls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.polls()).toHaveLength(2);
    expect(h.inferences()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).text).toBe("answer");
    expect(h.onStatus.mock.calls.map(([message]) => message).join(" ")).toMatch(/queued.*30s.*available/i);
  });

  it("stops at the cumulative queue wait limit without suggesting authentication fixes", async () => {
    vi.stubEnv("QODER_MODEL_QUEUE_MAX_WAIT_MS", "1000");
    const h = setup(undefined, [queue]);
    const outcome = h.run().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(isAuthKeyError(error)).toBe(false);
    expect(isRetriableError(error)).toBe(false);
    expect(formatProviderFailureForUser(error)).toMatch(/queue wait limit/i);
    expect(formatProviderFailureForUser(error)).not.toMatch(/API key|Authentication\/authorization/);
    expect(h.inferences()).toHaveLength(1);
    expect(h.finishes()).toHaveLength(1);
  });

  it("cancels a queued wait immediately and releases the lease", async () => {
    const h = setup(undefined, [queue]);
    const controller = new AbortController();
    const aborted = new Error("caller cancelled");
    const outcome = qoderProvider.stream!({ ...request, signal: controller.signal }, h.auth, h.onToken).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(aborted);
    expect(await outcome).toBe(aborted);
    expect(h.inferences()).toHaveLength(1);
    expect(h.polls()).toHaveLength(1);
    expect(h.finishes()).toHaveLength(1);
  });

  it("does not mask a successful answer when queue lease cleanup fails", async () => {
    const h = setup();
    let inference = 0;
    h.fetcher.mockImplementation(async (input) => {
      if (String(input).includes("/ask/finish?")) throw new Error("cleanup offline");
      if (String(input).includes("/queue/status?")) return new Response('{"isQueued":false}');
      return inference++ === 0 ? sse(queueBody, 403) : answer();
    });
    expect((await h.run()).text).toBe("answer");
    expect(h.onStatus.mock.calls.map(([message]) => message).join(" ")).toMatch(/lease.*release/i);
  });

  it.each(["content", "reasoning_content", "tool_calls"])("never replays queue failures after %s output", async (field) => {
    const delta = field === "tool_calls" ? { tool_calls: [{ index: 0, id: "call", function: { name: "fs_read", arguments: '{"path":' } }] } : { [field]: "partial" };
    const partial = `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta }] }), statusCodeValue: 200 })}\n\n`;
    const rejected = `data: ${JSON.stringify({ body: queueBody, statusCodeValue: 403 })}\n\n`;
    const h = setup(() => new Response(partial + rejected));
    const error = await h.run().catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(isAuthKeyError(error)).toBe(false);
    expect(isRetriableError(error)).toBe(false);
    expect(h.inferences()).toHaveLength(1);
    expect(h.polls()).toHaveLength(0);
  });

  it("retains genuine HTTP authentication errors and their response detail", async () => {
    const h = setup(() => new Response('{"message":"access denied"}', { status: 403 }));
    await expect(h.run()).rejects.toMatchObject({ status: 403, body: '{"message":"access denied"}' });
    expect(h.inferences()).toHaveLength(1);
    expect(h.polls()).toHaveLength(0);
    expect(h.finishes()).toHaveLength(0);
  });

  it("limits repeated queue admissions even when polling always reports ready", async () => {
    const h = setup();
    h.fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      h.calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("/queue/status?")) return new Response('{"isQueued":false}');
      if (url.includes("/ask/finish?")) return new Response("{}");
      return sse(queueBody, 403);
    });
    const error = await h.run().catch((failure: Error) => failure);
    expect(formatProviderFailureForUser(error)).toMatch(/recovery limit/);
    expect(isRetriableError(error)).toBe(false);
    expect(h.inferences()).toHaveLength(11);
    expect(h.polls()).toHaveLength(10);
    expect(h.finishes()).toHaveLength(1);
    const sets = h.inferences().map(({ init }) => JSON.parse(String(init?.body)).request_set_id);
    expect(new Set(sets).size).toBe(1);
  });

  it("keeps one cumulative wait budget across repeated queue admissions", async () => {
    vi.stubEnv("QODER_MODEL_QUEUE_MAX_WAIT_MS", "1000");
    const h = setup();
    h.fetcher.mockImplementation(async (input, init) => {
      const url = String(input);
      h.calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes("/queue/status?")) return new Response('{"isQueued":false,"retryAfterSeconds":0.5}');
      if (url.includes("/ask/finish?")) return new Response("{}");
      return sse(queueBody, 403);
    });
    const outcome = h.run().catch((failure: Error) => failure);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(formatProviderFailureForUser(await outcome)).toMatch(/queue wait limit/);
    expect(h.inferences()).toHaveLength(2);
    expect(h.polls()).toHaveLength(2);
  });

  it.each([401, 403, 404])("does not loop on a queue status endpoint returning %s", async (status) => {
    const h = setup();
    h.fetcher.mockImplementation(async (input) => {
      if (String(input).includes("/queue/status?")) return new Response('{"message":"access denied"}', { status });
      if (String(input).includes("/ask/finish?")) return new Response("{}");
      return sse(queueBody, 403);
    });
    const error = await h.run().catch((failure: Error) => failure);
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).includes("/queue/status?"))).toHaveLength(1);
    if (status === 404) expect(formatProviderFailureForUser(error)).toMatch(/queue status endpoint/);
    else expect(error).toMatchObject({ status });
  });

  it("bounds transient queue poll failures without resending the inference", async () => {
    const h = setup();
    h.fetcher.mockImplementation(async (input) => {
      if (String(input).includes("/queue/status?")) return new Response('{"message":"maintenance"}', { status: 503 });
      if (String(input).includes("/ask/finish?")) return new Response("{}");
      return sse(queueBody, 403);
    });
    const outcome = h.run().catch((failure: Error) => failure);
    await vi.advanceTimersByTimeAsync(60_000);
    const error = await outcome;
    expect(formatProviderFailureForUser(error)).toMatch(/polling failed after 3/);
    expect(isRetriableError(error)).toBe(false);
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).includes("/queue/status?"))).toHaveLength(3);
    expect(h.fetcher.mock.calls.filter(([url]) => String(url).endsWith("/inference"))).toHaveLength(1);
  });

  it("cancels while a queue status response body is stalled", async () => {
    const h = setup();
    const controller = new AbortController();
    const cancelled = vi.fn();
    h.fetcher.mockImplementation(async (input) => {
      if (String(input).includes("/queue/status?")) return new Response(new ReadableStream({ cancel: cancelled }));
      if (String(input).includes("/ask/finish?")) return new Response("{}");
      return sse(queueBody, 403);
    });
    const outcome = qoderProvider.stream!({ ...request, signal: controller.signal }, h.auth, h.onToken).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error("poll cancelled");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("returns successful non-queued streams without queue requests", async () => {
    const h = setup(answer);
    expect((await h.run()).text).toBe("answer");
    expect(h.calls).toHaveLength(1);
  });
});
