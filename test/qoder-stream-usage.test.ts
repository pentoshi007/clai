import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { qoderProvider } from "../src/llm/qoder/qoder.js";

vi.mock("../src/llm/qoder/qoder-signer.js", () => ({
  QoderSigner: {
    create: async () => ({
      prepareInfer: ({ body }: { body: string }) => ({ url: "https://test.invalid/inference", headers: {}, body }),
      free: () => {},
    }),
  },
}));

const auth = { apiKey: JSON.stringify({
  uid: "fixture", accessToken: "fixture", expireTime: 4_000_000_000, encryptUserInfo: "fixture",
  key: "fixture", machineId: "fixture", machineToken: "fixture",
}) };
const request = { model: "qfmodel:free", messages: [{ role: "user" as const, content: "hello" }] };
const usage = {
  prompt_tokens: 81, completion_tokens: 192, total_tokens: 273,
  prompt_tokens_details: { cached_tokens: 20 }, completion_tokens_details: { reasoning_tokens: 182 },
};
const expectedUsage = {
  promptTokens: 81, completionTokens: 192, totalTokens: 273,
  cachedPromptTokens: 20, reasoningTokens: 182, exact: true,
};
const finish = { choices: [{ delta: { content: "answer" }, finish_reason: "stop" }] };

function frame(body: object | string, wrapped = true): string {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const payload = wrapped ? JSON.stringify({ body: raw, statusCodeValue: 200 }) : raw;
  return `data: ${payload}\n\n`;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("Qoder trailing token usage", () => {
  it.each([true, false])("collects usage after finish_reason (wrapped=%s)", async (wrapped) => {
    const fetcher = vi.fn(async () => new Response(frame(finish, wrapped) + frame({ choices: [], usage }, wrapped) + frame("[DONE]", wrapped)));
    vi.stubGlobal("fetch", fetcher);
    const onToken = vi.fn();
    const result = await qoderProvider.stream!(request, auth, onToken);
    expect(result.usage).toEqual(expectedUsage);
    expect(result.text).toBe("answer");
    expect(onToken).toHaveBeenCalledExactlyOnceWith("answer");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("collects a final usage frame without a DONE sentinel or newline", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(frame(finish) + frame({ choices: [], usage }).trimEnd())));
    expect((await qoderProvider.complete(request, auth)).usage).toEqual(expectedUsage);
  });

  it("collects byte-fragmented trailing usage and preserves reasoning observation", async () => {
    const bytes = new TextEncoder().encode(frame({ choices: [{ delta: { reasoning_content: "thought 中" } }] }) + frame(finish) + frame({ choices: [], usage }) + frame("[DONE]"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); },
    }))));
    const result = await qoderProvider.complete(request, auth);
    expect(result.usage).toEqual({ ...expectedUsage, reasoningObserved: true });
    expect(result.reasoningBlock?.text).toBe("thought 中");
  });

  it("preserves usage on the finish frame without waiting for an open tail", async () => {
    const cancel = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame({ ...finish, usage }))); },
      cancel,
    }))));
    expect((await qoderProvider.complete(request, auth)).usage).toEqual(expectedUsage);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("waits for delayed usage after completion and cleans up its timer", async () => {
    const timersBefore = vi.getTimerCount();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(finish)));
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(frame({ choices: [], usage }) + frame("[DONE]")));
          controller.close();
        }, 100);
      },
    }))));
    const result = qoderProvider.complete(request, auth);
    await vi.advanceTimersByTimeAsync(100);
    expect((await result).usage).toEqual(expectedUsage);
    expect(vi.getTimerCount()).toBe(timersBefore);
  });

  it("bounds a stalled post-finish tail without discarding the completed answer", async () => {
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(frame(finish))); },
      cancel,
    })));
    vi.stubGlobal("fetch", fetcher);
    const result = qoderProvider.complete(request, auth);
    await vi.advanceTimersByTimeAsync(5_001);
    expect(await result).toMatchObject({ text: "answer", finishReason: "stop" });
    expect((await result).usage).toBeUndefined();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("preserves caller cancellation during the usage tail without replay", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode(frame(finish))); },
      cancel,
    })));
    vi.stubGlobal("fetch", fetcher);
    const result = qoderProvider.complete({ ...request, signal: controller.signal }, auth).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error("cancel usage tail");
    controller.abort(reason);
    expect(await result).toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("ignores late output after finish while still collecting usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(frame(finish) + frame({ choices: [{ delta: { content: "discarded", reasoning_content: "discarded" } }] }) + frame({ choices: [], usage }) + frame("[DONE]"))));
    const onToken = vi.fn();
    const result = await qoderProvider.stream!(request, auth, onToken);
    expect(result.text).toBe("answer");
    expect(result.reasoningBlock).toBeUndefined();
    expect(result.usage).toEqual(expectedUsage);
    expect(onToken).toHaveBeenCalledExactlyOnceWith("answer");
  });

  it("does not turn an error trailer into a retry of completed output", async () => {
    const fetcher = vi.fn(async () => new Response(frame(finish) + 'data: {"statusCodeValue":403,"body":"denied"}\n\n'));
    vi.stubGlobal("fetch", fetcher);
    expect((await qoderProvider.complete(request, auth)).text).toBe("answer");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("retains usage for tool-call completions", async () => {
    const tools = { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "fs_read", arguments: '{"path":"test.txt"}' } }] }, finish_reason: "tool_calls" }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(frame(tools) + frame({ choices: [], usage }) + frame("[DONE]"))));
    const result = await qoderProvider.complete(request, auth);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls?.[0]).toMatchObject({ id: "call-1", args: { path: "test.txt" } });
    expect(result.usage).toEqual(expectedUsage);
  });

  it("never invents usage when the provider omits it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(frame(finish) + frame("[DONE]"))));
    expect((await qoderProvider.complete(request, auth)).usage).toBeUndefined();
  });
});
