import { describe, expect, it } from "vitest";
import { buildChatBody, toCompletionResult } from "../src/llm/http.js";
import { cacheAffinityKey, sessionCacheAffinityKey } from "../src/llm/cache-affinity.js";
import { withSessionAffinity } from "../src/llm/session-affinity.js";
import { buildCompactionReplayMessages } from "../src/agent/compaction-executor.js";
import type { ChatMessage, ProviderId } from "../src/types.js";

const BASE: ChatMessage[] = [
  { role: "system", content: "stable system" },
  { role: "user", content: "initial goal" },
  { role: "assistant", content: "working" },
];

const APPENDED: ChatMessage[] = buildCompactionReplayMessages(
  {
    provider: "openrouter",
    model: "stealth/ox-alpha",
    messages: BASE,
  },
  [...BASE, { role: "assistant", content: "latest answer" }],
  "compact this exact request",
);

function body(providerId: ProviderId, messages = BASE): Record<string, unknown> {
  return JSON.parse(
    buildChatBody({
      providerId,
      model:
        providerId === "fireworks"
          ? "accounts/fireworks/models/kimi-k2p6"
          : "stealth/ox-alpha",
      messages,
      stream: true,
    }),
  ) as Record<string, unknown>;
}

describe("provider cache affinity", () => {
  it("is stable when a turn or compaction appends to the same conversation", () => {
    expect(cacheAffinityKey("openrouter", "stealth/ox-alpha", BASE)).toBe(
      cacheAffinityKey("openrouter", "stealth/ox-alpha", APPENDED),
    );
  });

  it("changes when the route or opening conversation changes", () => {
    const key = cacheAffinityKey("openrouter", "stealth/ox-alpha", BASE);
    expect(cacheAffinityKey("openrouter", "other-model", BASE)).not.toBe(key);
    expect(
      cacheAffinityKey("openrouter", "stealth/ox-alpha", [
        BASE[0]!,
        { role: "user", content: "different goal" },
      ]),
    ).not.toBe(key);
  });

  it("sends an OpenRouter session id that survives exact-prefix appends", () => {
    const first = body("openrouter", BASE);
    const compacted = body("openrouter", APPENDED);
    expect(first.session_id).toMatch(/^clai-[a-f0-9]{40}$/);
    expect(compacted.session_id).toBe(first.session_id);
  });

  it("sends stable Fireworks cache affinity and isolation keys", () => {
    const first = body("fireworks", BASE);
    const compacted = body("fireworks", APPENDED);
    expect(first.prompt_cache_key).toMatch(/^clai-[a-f0-9]{40}$/);
    expect(first.prompt_cache_isolation_key).toBe(first.prompt_cache_key);
    expect(compacted.prompt_cache_key).toBe(first.prompt_cache_key);
    expect(compacted.prompt_cache_isolation_key).toBe(
      first.prompt_cache_isolation_key,
    );
  });

  it("records visible reasoning even when the provider reports zero tokens", () => {
    const result = toCompletionResult("openrouter", "stealth/ox-alpha", {
      text: "answer",
      usage: {
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        exact: true,
        reasoningTokens: 0,
      },
      reasoningBlock: { text: "visible reasoning" },
    });
    expect(result.usage).toMatchObject({
      reasoningTokens: 0,
      reasoningObserved: true,
    });
  });

  it("keeps the session id constant across a compaction while a session is active", () => {
    const compactedAway: ChatMessage[] = [
      { role: "system", content: "stable system" },
      { role: "user", content: "compaction-era first message" },
    ];
    withSessionAffinity("ses-affinity-check", () => {
      const before = body("merge-gateway", BASE);
      const after = body("merge-gateway", compactedAway);
      expect(before.session_id).toMatch(/^clai-[a-f0-9]{40}$/);
      expect(after.session_id).toBe(before.session_id);
    });
  });

  it("does not add provider-specific cache fields to unrelated routes", () => {
    const payload = body("nvidia");
    expect(payload).not.toHaveProperty("session_id");
    expect(payload).not.toHaveProperty("prompt_cache_key");
    expect(payload).not.toHaveProperty("prompt_cache_isolation_key");
  });
});
