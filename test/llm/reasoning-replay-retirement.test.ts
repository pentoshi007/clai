import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionRequest, CompletionResult } from "../../src/types.js";
import { codexProvider } from "../../src/llm/codex.js";
import { codexConfigFor } from "../../src/llm/codex-config.js";
import { ProviderError } from "../../src/llm/http.js";
import { createReasoningArtifact, createReasoningArtifactProvenance } from "../../src/llm/reasoning-artifacts.js";
import { buildResponsesRequestBody } from "../../src/llm/responses-http.js";
import { tryCompleteOnce } from "../../src/llm/routing/attempt-complete.js";
import { tryStreamOnce } from "../../src/llm/routing/attempt-stream.js";
import { retireRejectedReasoningReplay } from "../../src/llm/routing/attempt-request.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";

const model = "gpt-6-luna";
const config = codexConfigFor({ accountId: "fixture", accessToken: "fixture" });
const provenance = createReasoningArtifactProvenance({ provider: "codex", model, dialect: "openai-compatible", endpoint: config.baseUrl });
const encrypted = (value: string) => createReasoningArtifact({
  kind: "encrypted", raw: { items: [{ type: "reasoning", id: `rs_${value}`, encrypted_content: value }] }, provenance,
  replay: { scope: "all-history", persistence: "all-turns" }, position: { sequence: 0, placement: "assistant" },
});

describe.each(["complete", "stream"] as const)("%s rejected reasoning retirement", (mode) => {
  it("retires rejected history once while preserving exact visible replay, fresh reasoning and cache affinity", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Stable system prefix" },
      { role: "user", content: "Inspect the source" },
      {
        role: "assistant", content: "Reading the source", reasoningArtifacts: [encrypted("expired")],
        toolCalls: [{ id: "call_1", name: "fs.read", args: { path: "src/main.ts" } }],
        responsesReplay: { provider: "codex", model, items: [
          { type: "reasoning", id: "rs_expired", encrypted_content: "expired" },
          { type: "message", id: "msg_original", role: "assistant", content: [{ type: "output_text", text: "Reading the source" }] },
          { type: "function_call", id: "fc_original", call_id: "call_1", name: "fs_read", arguments: '{"path":"src/main.ts"}' },
        ] },
      },
      { role: "tool", toolCallId: "call_1", name: "fs.read", content: "Verified source" },
      { role: "user", content: "Continue" },
    ];
    const bodies: Record<string, any>[] = [];
    const attempt = vi.fn(async (request: CompletionRequest): Promise<CompletionResult> => {
      const body = JSON.parse(buildResponsesRequestBody(config, request, model, mode === "stream"));
      bodies.push(body);
      if (body.input.some((item: Record<string, unknown>) => item.encrypted_content === "expired")) {
        throw new ProviderError("Invalid encrypted content", 400, "invalid_encrypted_content");
      }
      return { provider: "codex", model, text: "Completed", finishReason: "stop" };
    });
    const provider = { ...codexProvider, complete: attempt, stream: attempt };
    const statuses: string[] = [];
    const run = () => {
      const request: CompletionRequest = { provider: "codex", model, messages, thinking: { enabled: true, effort: "high" } };
      return mode === "complete"
        ? tryCompleteOnce(provider, "codex", request, model, {}, "initial", (text) => statuses.push(text))
        : tryStreamOnce(provider, "codex", request, model, {}, () => undefined, (text) => statuses.push(text), "initial");
    };
    await withSessionAffinity("replay-retirement", async () => {
      await run();
      messages.push({ role: "assistant", content: "Fresh result", reasoningArtifacts: [encrypted("fresh")] });
      messages.push({ role: "user", content: "Review the revision" });
      await run();
    });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(statuses.filter((text) => text.includes("rejected replayed reasoning"))).toHaveLength(1);
    expect(bodies[1]?.input).toContainEqual(expect.objectContaining({ id: "msg_original", role: "assistant" }));
    expect(bodies[1]?.input).toContainEqual(expect.objectContaining({ id: "fc_original", call_id: "call_1" }));
    expect(bodies[2]?.input).toContainEqual(expect.objectContaining({ encrypted_content: "fresh" }));
    expect(bodies[2]?.input.slice(0, bodies[1]!.input.length)).toEqual(bodies[1]?.input);
    expect(bodies.every((body) => body.prompt_cache_key === "replay-retirement")).toBe(true);
    expect(bodies.every((body) => body.reasoning.effort === "high")).toBe(true);
  });
});

it("keeps artifacts belonging to another model when retiring a rejected route", () => {
  const foreign = { ...encrypted("other"), provenance: { ...provenance, model: "other-model" } };
  const messages: ChatMessage[] = [{ role: "assistant", content: "Verified answer", reasoningArtifacts: [encrypted("expired"), foreign] }];
  retireRejectedReasoningReplay(messages, "codex", model);
  expect(messages[0]?.reasoningArtifacts).toEqual([foreign]);
  expect(messages[0]?.content).toBe("Verified answer");
});
