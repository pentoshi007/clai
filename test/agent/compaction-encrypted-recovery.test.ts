import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionRequest, CompletionResult } from "../../src/types.js";
import { captureResponsesReplay } from "../../src/llm/responses-replay.js";
import { createReasoningArtifact } from "../../src/llm/reasoning-artifacts.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import { codexConfigFor } from "../../src/llm/codex-config.js";
import { isInvalidReasoningContentError } from "../../src/llm/reasoning-errors.js";
import { withoutReasoningReplay, successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import { markStreamEmittedBytes } from "../../src/llm/stream-progress.js";

const { complete, stream } = vi.hoisted(() => ({
  complete: vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>(),
  stream: vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>(),
}));
vi.mock("../../src/llm/router.js", () => ({ completeWithProvider: complete, streamWithProvider: stream }));
const { executeCompactionSummary } = await import("../../src/agent/compaction-executor.js");

const model = "gpt-6.1-sol";
const config = codexConfigFor({ accessToken: "test-token", accountId: "test-account" });
const encryptedError = () => Object.assign(new Error("The encrypted content for item rs_old could not be verified. Reason: Encrypted content could not be decrypted or parsed."), {
  status: 400, body: JSON.stringify({ error: { code: "invalid_encrypted_content", type: "invalid_request_error" } }),
});
const summary: CompletionResult = { provider: "codex", model, text: "## Work\nAll requested changes were implemented.\n## Remaining\nRun the regression suite.", finishReason: "stop" };

function restoredHistory(): ChatMessage[] {
  const output = [
    { type: "reasoning", id: "rs_old", summary: [], encrypted_content: "stale-encrypted" },
    { type: "message", id: "msg_old", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
  ];
  const messages: ChatMessage[] = [
    { role: "system", content: "Project instructions" },
    { role: "user", content: "Fix the bug" },
    { role: "assistant", content: "Done.", responsesReplay: captureResponsesReplay("codex", model, output) },
    { role: "user", content: "Summarize the completed work" },
  ];
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
}

function wire(request: CompletionRequest): string {
  return buildResponsesBody(config, { model, messages: request.messages, stream: true });
}

function execution(messages: ChatMessage[], streaming = true) {
  return {
    provider: "codex" as const, model, systemContent: "Summarize", prompt: "Compact this session",
    maxTokens: 4096, sourceMessages: messages, stream: streaming, qualityRetry: false,
    retryOnRequestShapeRejection: false, retryOnServerError: false,
  };
}

beforeEach(() => {
  complete.mockReset().mockResolvedValue(summary);
  stream.mockReset().mockResolvedValue(summary);
});

describe("Codex rejected encrypted state recovery", () => {
  it("recognizes the exact rejection but not server/auth failures", () => {
    expect(isInvalidReasoningContentError(encryptedError())).toBe(true);
    expect(isInvalidReasoningContentError(Object.assign(encryptedError(), { status: 500 }))).toBe(false);
    expect(isInvalidReasoningContentError(Object.assign(encryptedError(), { status: 401 }))).toBe(false);
  });

  it("removes full Responses replay, not just reasoning artifacts, without mutating history", () => {
    const messages = restoredHistory();
    const request: CompletionRequest = { provider: "codex", model, messages };
    expect(wire(request)).toContain("stale-encrypted");
    expect(wire(withoutReasoningReplay(request))).not.toContain("stale-encrypted");
    expect(messages).toEqual(restoredHistory());
  });

  it.each([true, false])("recovers restored compaction on the same model (stream=%s)", async (streaming) => {
    const messages = restoredHistory();
    const dispatch = streaming ? stream : complete;
    dispatch.mockImplementation(async (request) => {
      if (wire(request).includes("stale-encrypted")) throw encryptedError();
      return summary;
    });
    expect(await executeCompactionSummary(execution(messages, streaming))).toBe(summary.text);
    expect(dispatch).toHaveBeenCalledTimes(2);
    const retry = dispatch.mock.calls[1]![0];
    expect(retry.model).toBe(model);
    expect(retry.provider).toBe("codex");
    expect(retry.messages.map(({ content }) => content)).toEqual([...messages.map(({ content }) => content), "Compact this session"]);
    expect(retry.forceReasoningReplay).toBe(false);
    expect(messages).toEqual(restoredHistory());
  });

  it("recovers the captured-request path without changing generation settings or tools", async () => {
    const request: CompletionRequest = { provider: "codex", model, messages: restoredHistory(), thinking: { enabled: true, effort: "high" }, tools: [{ name: "fs.read", description: "Read", parameters: { type: "object" } }] };
    stream.mockRejectedValueOnce(encryptedError()).mockResolvedValue(summary);
    await executeCompactionSummary({ ...execution(request.messages), baseRequest: successfulRequestSnapshot("codex", model, request), history: request.messages });
    const retry = stream.mock.calls[1]![0];
    expect(retry.thinking).toEqual(request.thinking);
    expect(retry.tools).toEqual(request.tools);
    expect(wire(retry)).not.toContain("stale-encrypted");
  });

  it.each(["canonical", "legacy"] as const)("retains tool history while removing rejected %s reasoning", async (kind) => {
    const raw = { type: "reasoning", id: "rs_old", encrypted_content: "stale-encrypted" };
    const artifact = createReasoningArtifact({
      kind: "encrypted", raw,
      provenance: { provider: "codex", model, dialect: "meta-responses" },
      replay: { scope: "all-history", persistence: "all-turns" },
    });
    const messages: ChatMessage[] = [
      { role: "user", content: "Read the file" },
      {
        role: "assistant", content: "Reading file",
        toolCalls: [{ id: "call_read", name: "fs.read", args: { path: "file.txt" }, thoughtSignature: "old-signature" }],
        ...(kind === "canonical" ? { reasoningArtifacts: [artifact] } : { reasoningBlock: { text: "", items: [raw] } }),
      },
      { role: "tool", toolCallId: "call_read", name: "fs.read", content: "File evidence", ok: true },
      { role: "assistant", content: "Done." },
    ];
    const original = structuredClone(messages);
    stream.mockRejectedValueOnce(encryptedError()).mockResolvedValue(summary);
    await executeCompactionSummary(execution(messages));
    expect(JSON.stringify(stream.mock.calls[0]![0])).toContain("stale-encrypted");
    const retry = stream.mock.calls[1]![0];
    expect(JSON.stringify(retry)).not.toContain("stale-encrypted");
    expect(retry.messages[1]!.toolCalls).toEqual([{ id: "call_read", name: "fs.read", args: { path: "file.txt" } }]);
    expect(retry.messages[2]).toEqual(original[2]);
    expect(messages).toEqual(original);
  });

  it("does not reintroduce rejected replay when a recovered summary needs a quality retry", async () => {
    stream.mockRejectedValueOnce(encryptedError())
      .mockResolvedValueOnce({ ...summary, finishReason: "length" })
      .mockResolvedValue(summary);
    expect(await executeCompactionSummary(execution(restoredHistory()))).toBe(summary.text);
    expect(stream).toHaveBeenCalledTimes(3);
    for (const [retry] of stream.mock.calls.slice(1)) {
      expect(wire(retry)).not.toContain("stale-encrypted");
      expect(retry.model).toBe(model);
    }
  });

  it("does not recover a rejection after cancellation", async () => {
    const controller = new AbortController();
    stream.mockImplementationOnce(async () => {
      controller.abort();
      throw encryptedError();
    });
    await expect(executeCompactionSummary({ ...execution(restoredHistory()), signal: controller.signal }))
      .rejects.toThrow();
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("retries at most once when rejection persists", async () => {
    stream.mockRejectedValue(encryptedError());
    await expect(executeCompactionSummary(execution(restoredHistory()))).rejects.toThrow("encrypted content");
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("does not retry after streamed output", async () => {
    stream.mockRejectedValue(markStreamEmittedBytes(encryptedError(), 10));
    await expect(executeCompactionSummary(execution(restoredHistory()))).rejects.toThrow("encrypted content");
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it("does not retry unrelated 400s or a request without opaque replay", async () => {
    stream.mockRejectedValueOnce(Object.assign(new Error("Unknown model"), { status: 400 }));
    await expect(executeCompactionSummary(execution(restoredHistory()))).rejects.toThrow("Unknown model");
    expect(stream).toHaveBeenCalledTimes(1);
    stream.mockClear().mockRejectedValue(encryptedError());
    await expect(executeCompactionSummary(execution([{ role: "user", content: "Summarize" }]))).rejects.toThrow("encrypted content");
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
