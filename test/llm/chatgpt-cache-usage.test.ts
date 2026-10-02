import { afterEach, describe, expect, it, vi } from "vitest";
import { codexProvider } from "../../src/llm/codex.js";
import { encodeCodexKey } from "../../src/llm/codex-auth.js";
import { parseResponsesUsage } from "../../src/llm/responses-parse.js";
import { withSessionAffinity } from "../../src/llm/session-affinity.js";
import { SessionUsageLedger } from "../../src/app/controllers/session-usage-ledger.js";
import { formatSessionUsage } from "../../src/ui-core/rendering/format-usage.js";

const auth = { apiKey: encodeCodexKey({ accessToken: "fixture-access-token", accountId: "fixture-account" }) };
const request = { model: "gpt-5.4", messages: [{ role: "user" as const, content: "Inspect cache accounting" }] };
afterEach(() => { vi.unstubAllGlobals(); });

describe("ChatGPT cache-write telemetry", () => {
  it.each([
    { cache_write_tokens: 13 },
    { cacheWriteTokens: 13 },
    { input_tokens_details: { cache_creation_tokens: 13 } },
    { inputTokensDetails: { cacheWriteTokens: 13 } },
    { inputTokensDetails: { cacheCreationTokens: 13 } },
  ])("reads explicitly reported writes from %j", (shape) => {
    expect(parseResponsesUsage({ input_tokens: 100, output_tokens: 20, ...shape })?.cacheCreationTokens).toBe(13);
  });

  it("does not lose a valid cache counter behind an invalid alias", () => {
    const usage = parseResponsesUsage({ input_tokens: "invalid", prompt_tokens: 100, output_tokens: 20, input_tokens_details: { cache_write_tokens: "invalid" }, cache_write_tokens: 13 });
    expect(usage?.promptTokens).toBe(100);
    expect(usage?.cacheCreationTokens).toBe(13);
  });

  it.each([undefined, 0, 13])("preserves unknown/zero/nonzero writes through JSON completion and persistence: %s", async (writes) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 64, ...(writes !== undefined ? { cache_write_tokens: writes } : {}) } },
    }), { headers: { "content-type": "application/json" } })));
    const result = await withSessionAffinity("cache-write-fixture", () => codexProvider.complete(request, auth));
    expect(result.usage?.cacheCreationTokens).toBe(writes);
    const ledger = new SessionUsageLedger();
    ledger.record(result.usage!, "codex", request.model);
    const restored = new SessionUsageLedger();
    restored.restore(JSON.parse(JSON.stringify(ledger.persist())));
    expect(restored.report().routes[0]?.cacheCreationTokens).toBe(writes);
    const body = formatSessionUsage(restored.report(), { sessionId: "cache-write-fixture" });
    if (writes === undefined) expect(body).not.toContain("cache write");
    else expect(body).toContain(`cache write ${writes}`);
  });

  it("keeps writes and cache reads when later SSE snapshots omit them, without double-counting", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "done" },
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 64, cache_write_tokens: 13 } } } },
      { usage: { input_tokens: 100, output_tokens: 20 } },
      { usage: { input_tokens_details: { cache_write_tokens: 0 } } },
    ];
    const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })));
    const result = await withSessionAffinity("cache-stream-fixture", () => codexProvider.stream(request, auth, () => undefined));
    expect(result.usage).toMatchObject({ promptTokens: 100, completionTokens: 20, totalTokens: 120, cachedPromptTokens: 64, cacheCreationTokens: 0 });
  });
});
