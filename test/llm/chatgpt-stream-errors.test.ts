import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexProvider, resetCodexModelCache } from "../../src/llm/codex.js";
import { encodeCodexKey } from "../../src/llm/codex-auth.js";
import { resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { completeWithProvider, streamWithProvider } from "../../src/llm/router.js";
import { sleep, SERVER_ERROR_MAX_ATTEMPTS } from "../../src/llm/routing/error-classification.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import type { CompletionRequest } from "../../src/types.js";

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...original,
    getProviderKeys: async (provider: string) => provider === "codex" ? {
      keys: [{ id: "fixture", value: encodeCodexKey({ accountId: "fixture", accessToken: "fixture", expiresAt: Date.now() + 3_600_000 }), createdAt: 0 }],
      activeIndex: 0, source: "local",
    } : original.getProviderKeys(provider),
  };
});

vi.mock("../../src/llm/routing/error-classification.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/llm/routing/error-classification.js")>(),
  sleep: vi.fn(async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted()),
}));

const model = "gpt-6.1-sol";
const auth = { apiKey: encodeCodexKey({ accountId: "fixture", accessToken: "fixture" }) };
const requestId = "fb7489b0-c227-4d68-bd4d-aeb6a511e448";
const error = { message: `An error occurred while processing your request. Please include the request ID ${requestId} in your message.`, type: "server_error", code: "server_error", param: null };
const request: CompletionRequest = { provider: "codex", model, messages: [{ role: "user", content: "Continue" }], thinking: { enabled: true, effort: "max" } };
const completed = { type: "response.completed", response: { id: "resp_complete", status: "completed", output: [{ type: "message", id: "msg_complete", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Recovered" }] }] } };
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const frames = {
  error: { type: "error", sequence_number: 2, error },
  failed: { type: "response.failed", response: { id: "resp_failed", error } },
};

function installTransport(respond: (attempt: number) => Response) {
  const bodies: Record<string, any>[] = [];
  const headers: Headers[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (String(url).includes("/models?")) return new Response(JSON.stringify({ models: [{ slug: model, supported_reasoning_levels: ["low", "high", "max"], supports_reasoning_summary_parameter: true }] }), { headers: { "content-type": "application/json" } });
    bodies.push(JSON.parse(String(init?.body)));
    headers.push(new Headers(init?.headers));
    return respond(bodies.length);
  }));
  return { bodies, headers };
}

beforeEach(() => {
  resetCodexModelCache();
  resetReasoningKnowledge();
  vi.mocked(sleep).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChatGPT stream failures", () => {
  it.each(Object.entries(frames))("preserves the status, structured body and request ID for %s frames", async (_kind, frame) => {
    installTransport(() => sse(frame));
    await expect(codexProvider.stream!(request, auth, () => {})).rejects.toMatchObject({ status: 500, body: expect.stringContaining('"code":"server_error"'), message: expect.stringContaining(requestId) });
  });

  it.each(["stream", "complete"] as const)("retries transient %s failures without changing effort, history or session identity", async (mode) => {
    const { bodies, headers } = installTransport((attempt) => attempt < 3 ? sse(frames.error) : sse(completed));
    const onToken = vi.fn();
    const result = await withSessionAffinity("chatgpt-retry-fixture", () => mode === "stream" ? streamWithProvider(request, onToken, { onStatus: () => {} }) : completeWithProvider(request));
    expect(result.text).toBe("Recovered");
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(bodies[0]!.reasoning.effort).toBe("max");
    expect(headers.map((header) => header.get("session-id"))).toEqual(Array(3).fill("chatgpt-retry-fixture"));
    expect(new Set(headers.map((header) => header.get("x-client-request-id"))).size).toBe(3);
    expect(vi.mocked(sleep).mock.calls.map(([delay]) => delay)).toEqual([1_000, 2_000]);
    if (mode === "stream") expect(onToken).toHaveBeenCalledExactlyOnceWith("Recovered");
  });

  it("bounds repeated server failures and keeps the final provider request ID", async () => {
    const { bodies } = installTransport(() => sse(frames.failed));
    await expect(streamWithProvider(request, () => {})).rejects.toMatchObject({ status: 500, message: expect.stringContaining(requestId) });
    expect(bodies).toHaveLength(SERVER_ERROR_MAX_ATTEMPTS);
    expect(sleep).toHaveBeenCalledTimes(SERVER_ERROR_MAX_ATTEMPTS - 1);
  });

  it.each([{ maxRetries: 0 }, { singleDispatch: true }])("honors caller retry policy %j", async (options) => {
    const { bodies } = installTransport(() => sse(frames.error));
    await expect(streamWithProvider(request, () => {}, options)).rejects.toMatchObject({ status: 500 });
    expect(bodies).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    { type: "response.output_text.delta", delta: "Partial answer" },
    { type: "response.reasoning_summary_text.delta", delta: "Checking evidence" },
    { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell", arguments: "" } },
  ])("does not replay a request after emitting $type", async (progress) => {
    const { bodies } = installTransport(() => sse(progress, frames.error));
    await expect(streamWithProvider({ ...request, onStreamEvent: () => {} }, () => {})).rejects.toMatchObject({ status: 500 });
    expect(bodies).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not treat an invalid request as a transient server failure", async () => {
    const { bodies } = installTransport(() => sse({ type: "error", error: { type: "invalid_request_error", code: "invalid_request_error", message: "Invalid request" } }));
    await expect(streamWithProvider(request, () => {})).rejects.toMatchObject({ status: 400 });
    expect(bodies).toHaveLength(1);
  });

  it("classifies a failed JSON stream fallback using the same error code", async () => {
    const { bodies } = installTransport((attempt) => attempt === 1
      ? new Response(JSON.stringify({ status: "failed", error }), { headers: { "content-type": "application/json" } })
      : sse(completed));
    expect((await streamWithProvider(request, () => {}, { onStatus: () => {} })).text).toBe("Recovered");
    expect(bodies).toHaveLength(2);
  });

  it("aborts retry waits without sending another request", async () => {
    const controller = new AbortController();
    const { bodies } = installTransport(() => sse(frames.error));
    await expect(streamWithProvider({ ...request, signal: controller.signal }, () => {}, {
      onStatus: () => controller.abort(new Error("Cancelled retry")),
    })).rejects.toThrow("Cancelled retry");
    expect(bodies).toHaveLength(1);
  });
});
