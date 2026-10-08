import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qoderProvider } from "../src/llm/qoder/qoder.js";
import { isRetriableError } from "../src/llm/routing/error-classification.js";
import { qoderTransportHeaders } from "../src/llm/qoder/qoder-http.js";

vi.mock("../src/llm/qoder/qoder-signer.js", () => ({
  QoderSigner: {
    create: async () => ({
      prepareInfer: ({ body }: { body: string }) => ({ url: "https://test.invalid/inference", headers: {}, body }),
      free: () => {},
    }),
  },
}));
const credential = { uid: "fixture", accessToken: "fixture", expireTime: 4_000_000_000, encryptUserInfo: "fixture", key: "fixture", machineId: "fixture", machineToken: "fixture" };
const auth = { apiKey: JSON.stringify(credential) };
const request = { model: "qfmodel:free", messages: [{ role: "user" as const, content: "hello" }] };
const completeFrame = `data: ${JSON.stringify({ body: JSON.stringify({ choices: [{ delta: { content: "answer 中" }, finish_reason: "stop" }] }), statusCodeValue: 200 })}`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Qoder stream lifecycle", () => {
  it("flushes a final complete frame without a trailing newline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(completeFrame)));
    expect((await qoderProvider.complete(request, auth)).text).toBe("answer 中");
  });

  it("handles byte-fragmented UTF-8 and CRLF frames", async () => {
    const bytes = new TextEncoder().encode(`${completeFrame}\r\n\r\ndata: [DONE]\r\n\r\n`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    }))));
    expect((await qoderProvider.complete(request, auth)).text).toBe("answer 中");
  });

  it("does not let errors after a finished generation invalidate the answer", async () => {
    const extra = 'data: {"statusCodeValue":403,"body":"denied"}\n\n';
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`${completeFrame}\n\n${extra}`)));
    expect((await qoderProvider.complete(request, auth)).text).toBe("answer 中");
  });

  it("does not return a successful partial answer on premature EOF", async () => {
    const fetcher = vi.fn(async () => new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
    vi.stubGlobal("fetch", fetcher);
    const error = await qoderProvider.stream!(request, auth, () => {}).catch((failure: Error) => failure);
    expect(error).toMatchObject({ status: 502 });
    expect(isRetriableError(error)).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("cancels a stalled body read and preserves the caller's abort reason", async () => {
    const controller = new AbortController();
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
    vi.stubGlobal("fetch", fetcher);
    const outcome = qoderProvider.stream!({ ...request, signal: controller.signal }, auth, () => {}).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error("stream cancelled");
    controller.abort(reason);
    expect(await outcome).toBe(reason);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("bounds waiting for response headers before any SSE stream exists", async () => {
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetcher);
    const outcome = qoderProvider.stream!(request, auth, () => {}).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await outcome;
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(isRetriableError(error)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("removes transport-only headers case-insensitively", () => {
    const headers = new Headers(qoderTransportHeaders(credential, { connection: "keep-alive", "content-length": "0", "ACCEPT-ENCODING": "identity" }));
    expect(headers.has("connection")).toBe(false);
    expect(headers.has("content-length")).toBe(false);
    expect(headers.has("accept-encoding")).toBe(false);
    expect(headers.get("Cosy-MachineToken")).toBe("fixture");
  });
});
