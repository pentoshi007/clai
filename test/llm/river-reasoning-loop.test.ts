import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearModelCatalogFacts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { riverProvider } from "../../src/llm/river.js";
import { openAiCompatibleStream } from "../../src/llm/http.js";
import { RIVER_GLM_MODEL } from "../../src/llm/river-models.js";
import { isRetriableError } from "../../src/llm/routing/error-classification.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";
import type { ProviderStreamEvent } from "../../src/llm/stream-events.js";
import { REQUEST, sse, TOOL, transport } from "./river-fixtures.js";

let sequence = 0;
let apiKey: string;

beforeEach(() => {
  apiKey = `rv_loop_fixture_${++sequence}`;
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});

function reasoning(text: string) {
  return { choices: [{ delta: { reasoning_content: text } }] };
}

function liveStream(frames: readonly unknown[]) {
  let index = 0;
  const cancel = vi.fn();
  const encoder = new TextEncoder();
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[index++])}\n\n`));
        return;
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
    cancel,
  }), { headers: { "content-type": "text/event-stream" } });
  return { response, cancel, framesRead: () => index };
}

const request = { ...REQUEST, thinking: { enabled: true, effort: "max" as const } };

describe("River DeepSeek repetitive reasoning protection", () => {
  it.each(["hmm ", "0xdeadbeef ", "嗯……", "0123456789abcdef".repeat(6)])(
    "stops a repeating %j pattern and cancels upstream without retrying",
    async (pattern) => {
      const text = pattern.repeat(Math.ceil(12_000 / pattern.length));
      const frames = Array.from({ length: Math.ceil(text.length / 17) }, (_, index) =>
        reasoning(text.slice(index * 17, (index + 1) * 17)),
      );
      const stream = liveStream(frames);
      const { generations } = transport(() => stream.response);
      const events: ProviderStreamEvent[] = [];
      const error = await tryStreamOnce(riverProvider, "river", {
        ...request,
        onStreamEvent: (event) => events.push(event),
      }, REQUEST.model!, { apiKey }, () => {}, undefined, "initial").then(() => undefined, (error: unknown) => error);
      expect(error).toMatchObject({ retryable: false, message: expect.stringMatching(/repetitive reasoning loop/i) });
      expect(isRetriableError(error)).toBe(false);
      expect(stream.cancel).toHaveBeenCalledTimes(1);
      expect(stream.framesRead()).toBeLessThan(frames.length);
      expect(generations).toHaveLength(1);
      expect(generations[0]!.signal?.aborted).toBe(true);
      expect(events.some((event) => event.type === "provider_terminal")).toBe(false);
      expect(events.some((event) => event.type === "reasoning_artifact_available")).toBe(false);
    },
  );

  it("detects a large repetitive delta, not just repeated SSE frames", async () => {
    const stream = liveStream([reasoning("hmm ".repeat(12_000))]);
    transport(() => stream.response);
    const error = await riverProvider.stream!(request, { apiKey }, () => {})
      .then(() => undefined, (error: unknown) => error);
    expect(error).toMatchObject({ message: expect.stringMatching(/repetitive reasoning loop/i) });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it("allows long coherent max-effort reasoning and preserves it for replay", async () => {
    const text = Array.from({ length: 1_200 }, (_, index) =>
      `Check candidate ${index}, compare the evidence, then evaluate the next possibility.\n`,
    ).join("");
    transport(() => sse([
      ...Array.from({ length: Math.ceil(text.length / 113) }, (_, index) => reasoning(text.slice(index * 113, (index + 1) * 113))),
      { choices: [{ delta: { content: "The evidence supports the answer." }, finish_reason: "stop" }] },
    ]));
    const result = await riverProvider.stream!(request, { apiKey }, () => {});
    expect(result.text).toBe("The evidence supports the answer.");
    expect(result.reasoningBlock?.text).toBe(text);
    expect(result.reasoningArtifacts?.[0]?.raw).toBe(text);
  });

  it("does not mistake growing cumulative reasoning snapshots for a loop", async () => {
    const text = Array.from({ length: 160 }, (_, index) => `Inspect file ${index}; verify its contracts. `).join("");
    transport(() => sse([
      ...Array.from({ length: Math.ceil(text.length / 80) }, (_, index) => reasoning(text.slice(0, (index + 1) * 80))),
      { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] },
    ]));
    const result = await riverProvider.stream!(request, { apiKey }, () => {});
    expect(result.reasoningBlock?.text).toBe(text);
    expect(result.text).toBe("Done");
  });

  it("does not treat repetitions separated by answer progress as one loop", async () => {
    transport(() => sse([
      reasoning("hmm ".repeat(600)),
      { choices: [{ delta: { content: "I found a result. " } }] },
      reasoning("hmm ".repeat(601)),
      { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] },
    ]));
    const result = await riverProvider.stream!(request, { apiKey }, () => {});
    expect(result.text).toBe("I found a result. Done");
  });

  it("resets repetition tracking when a tool call makes progress", async () => {
    transport(() => sse([
      reasoning("hmm ".repeat(600)),
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_read", type: "function", function: { name: "fs_read", arguments: '{"path":"README.md"}' } }] } }] },
      reasoning("hmm ".repeat(601)),
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]));
    const result = await riverProvider.stream!({ ...request, tools: [TOOL] }, { apiKey }, () => {});
    expect(result.toolCalls).toMatchObject([{ id: "call_read", name: "fs.read" }]);
  });

  it("does not change DeepSeek streaming on other providers", async () => {
    const text = "hmm ".repeat(1_200);
    transport(() => sse([
      reasoning(text),
      { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] },
    ]));
    const result = await openAiCompatibleStream({
      provider: "TokenRouter", providerId: "tokenrouter", model: REQUEST.model!,
      messages: REQUEST.messages, baseUrl: "https://gateway.example/v1", apiKey,
      reasoning: request.thinking, onToken: () => {},
    });
    expect(result.reasoningBlock?.text).toBe(text);
  });

  it("leaves unrelated River models unchanged", async () => {
    const text = "hmm ".repeat(1_200);
    transport(() => sse([
      reasoning(text),
      { choices: [{ delta: { content: "Done" }, finish_reason: "stop" }] },
    ]));
    const result = await riverProvider.stream!({ ...request, model: RIVER_GLM_MODEL }, { apiKey }, () => {});
    expect(result.reasoningBlock?.text).toBe(text);
  });
});
