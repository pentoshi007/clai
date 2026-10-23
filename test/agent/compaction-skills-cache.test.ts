import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionRequest, CompletionResult, ProviderId } from "../../src/types.js";
import { compactMessagesWithSummary, isCompactionMemoryMessage } from "../../src/agent/context-manager.js";
import { successfulRequestSnapshot } from "../../src/llm/routing/attempt-request.js";
import { buildAnthropicBody } from "../../src/llm/anthropic.js";
import { geminiBody } from "../../src/llm/gemini.js";
import { buildChatBody } from "../../src/llm/wire/chat-body.js";
import { buildResponsesBody } from "../../src/llm/responses-request.js";
import { codexConfigFor } from "../../src/llm/codex-config.js";
import { META_STREAM_TERMINAL } from "../../src/llm/stream-terminal.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { getToolDefinitions } from "../../src/tools/definitions.js";

const { complete } = vi.hoisted(() => ({ complete: vi.fn<(request: CompletionRequest) => Promise<CompletionResult>>() }));
vi.mock("../../src/llm/router.js", () => ({ completeWithProvider: complete, streamWithProvider: vi.fn() }));
const { executeCompactionSummary } = await import("../../src/agent/compaction-executor.js");

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
interface Prefix {
  readonly header: string;
  readonly timeline: readonly string[];
}

type Route = "anthropic" | "gemini" | "chat" | "responses";

function withoutCacheMarkers(value: Json): Json {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "cache_control")
    .map(([key, child]) => [key, withoutCacheMarkers(child)]));
}

function wirePrefix(request: CompletionRequest, route: Route): Prefix {
  if (route === "anthropic") {
    const body: { system: Json; tools: Json; thinking: Json; tool_choice: Json; messages: Array<{ role: string; content: string | Json[] }> } = JSON.parse(buildAnthropicBody(request, false));
    return {
      header: JSON.stringify([body.system, body.tools, body.thinking, body.tool_choice]),
      timeline: body.messages.flatMap(message => {
        const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
        return parts.map(part => JSON.stringify([message.role, withoutCacheMarkers(part)]));
      }),
    };
  }
  if (route === "gemini") {
    const body: { systemInstruction: Json; tools: Json; toolConfig: Json; contents: Array<{ role: string; parts: Json[] }> } = JSON.parse(geminiBody(request));
    return {
      header: JSON.stringify([body.systemInstruction, body.tools, body.toolConfig]),
      timeline: body.contents.flatMap(message => message.parts.map(part => JSON.stringify([message.role, part]))),
    };
  }
  if (route === "responses") {
    const config = request.provider === "codex" ? codexConfigFor({ accessToken: "fixture", accountId: "fixture" }) : {
      baseUrl: "https://api.openai.com/v1", providerId: "openai" as const, displayName: "OpenAI",
      artifactDialect: "openai-compatible" as const, terminalPolicy: META_STREAM_TERMINAL, instructionsField: "leading-instructions" as const,
      buildHeaders: () => ({}), reasoningPayload: () => undefined, bodyExtras: () => ({}),
    };
    const body: { instructions: Json; tools: Json; prompt_cache_key: Json; input: Json[] } = JSON.parse(buildResponsesBody(config, { ...request, stream: false }));
    return { header: JSON.stringify([body.instructions, body.tools, body.prompt_cache_key]), timeline: body.input.map(part => JSON.stringify(part)) };
  }
  const body: { tools: Json; prompt_cache_key: Json; messages: Json[] } = JSON.parse(buildChatBody({ ...request, providerId: request.provider, stream: false }));
  return { header: JSON.stringify([body.tools, body.prompt_cache_key]), timeline: body.messages.map(part => JSON.stringify(withoutCacheMarkers(part))) };
}

const summary = "## Active goal\nContinue the API assessment.\n\n## Context gathered\nThe API domain guide was read before assessing the tenant boundary.\n\n## Current state and next steps\nValidate the remaining tenant-isolation hypothesis using controlled fixtures.";

function initialRequest(provider: ProviderId, model: string): CompletionRequest {
  const file = join(tmpdir(), "cache-prefix-skill", "clai-superman-skill", "SKILL.md");
  const reference = join(tmpdir(), "cache-prefix-skill", "clai-superman-skill", "references", "web-api.md");
  const messages: ChatMessage[] = [
    { role: "system", content: "Stable agent instructions, tools and environment" },
    { role: "user", content: "Assess the API tenant boundary." },
    { role: "assistant", content: "", toolCalls: [{ id: "load", name: "skill.load", args: { name: "clai-superman-skill" } }] },
    { role: "tool", toolCallId: "load", name: "skill.load", ok: true, content: `skill: clai-superman-skill [bundled/clai]\nfile: ${file}\n\n---\n\nFull skill body.` },
    { role: "assistant", content: "", toolCalls: [{ id: "guide", name: "fs.read", args: { path: reference } }] },
    { role: "tool", toolCallId: "guide", name: "fs.read", ok: true, content: "Full domain reference." },
    { role: "assistant", content: "The boundary is mapped." },
    { role: "user", content: "Continue with the remaining hypothesis." },
  ];
  return { provider, model, messages, tools: getToolDefinitions(), thinking: { enabled: true, effort: "high" }, temperature: 0.7, toolChoice: "auto", parallelToolCalls: true };
}

beforeEach(() => {
  complete.mockReset().mockImplementation(async request => ({ provider: request.provider!, model: request.model!, text: summary, finishReason: "stop" }));
});

it.each([
  ["anthropic", "claude-sonnet-4-5", "anthropic"],
  ["gemini", "gemini-2.5-pro", "gemini"],
  ["openai", "gpt-4o-mini", "chat"],
  ["nvidia", "openai/gpt-oss-20b", "chat"],
  ["tokenharbor", "kimi-k3", "chat"],
  ["openai", "gpt-4o-mini", "responses"],
  ["codex", "gpt-6.1-sol", "responses"],
] as const)("preserves the serialized %s normal→compaction prefix (%s, %s) with skill recovery over three rounds", async (provider, model, route) => {
  await withSessionAffinity("skill-compaction-prefix", async () => {
    let request = initialRequest(provider, model);
    for (let round = 0; round < 3; round += 1) {
      const original = structuredClone(request);
      const snapshot = successfulRequestSnapshot(provider, model, request);
      const history: ChatMessage[] = [...request.messages, { role: "assistant", content: "The current probe is complete." }];
      const result = await compactMessagesWithSummary(history, (prompt, stage) => executeCompactionSummary({
        provider, model, systemContent: "Not a replacement for the stable system", prompt,
        sourceMessages: stage?.sourceMessages, history, baseRequest: snapshot, maxTokens: 12_288,
        stream: false, qualityRetry: false, retryOnTruncation: false, retryOnRequestShapeRejection: false,
      }), { budgetTokens: 0, singleAdmission: true, forceDirectSinglePass: true });
      expect(complete).toHaveBeenCalledTimes(round + 1);
      const sent = complete.mock.calls[round]![0];
      expect(sent.messages.slice(0, snapshot.messages.length)).toEqual(snapshot.messages);
      expect(sent.tools).toEqual(request.tools);
      expect(sent.thinking).toEqual(request.thinking);
      const normalWire = wirePrefix(request, route);
      const compactionWire = wirePrefix(sent, route);
      expect(compactionWire.header).toBe(normalWire.header);
      expect(compactionWire.timeline.slice(0, normalWire.timeline.length)).toEqual(normalWire.timeline);
      const memory = result.messages.find(isCompactionMemoryMessage)!;
      expect(memory.compaction?.skills?.[0]?.resources).toEqual(["references/web-api.md"]);
      expect(memory.content.match(/## Skill recovery after compaction/g)).toHaveLength(1);
      expect(request).toEqual(original);
      request = { ...request, messages: JSON.parse(JSON.stringify([...result.messages, { role: "user", content: `Continue round ${round + 1}.` }])) };
    }
  });
});
