import { afterEach, describe, expect, it, vi } from "vitest";
import { codexProvider } from "../../src/llm/codex.js";
import { encodeCodexKey } from "../../src/llm/codex-auth.js";
import { completeWithProvider, getProvider } from "../../src/llm/router.js";
import { currentSessionAffinity, withSessionAffinity } from "../../src/llm/session-affinity.js";
import { resetResponsesPreflight, selectResponsesWire } from "../../src/llm/wire/responses-preflight.js";
import type { ResponsesFirstOptions } from "../../src/llm/wire/responses-first.js";

const messages = [{ role: "user" as const, content: "Identical reusable prefix" }];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetResponsesPreflight();
});

describe("independent cache sessions", () => {
  it.each(["gpt-5.4", "gpt-5.4-mini"])("keeps same-model siblings independent with main model %s", async (mainModel) => {
    const calls: { model: string; key: string; session: string | null; thread: string | null; subagent: string | null; store: unknown }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string; prompt_cache_key: string; store: unknown };
      const headers = new Headers(init?.headers);
      calls.push({ model: body.model, key: body.prompt_cache_key, session: headers.get("session-id"), thread: headers.get("thread-id"), subagent: headers.get("x-openai-subagent"), store: body.store });
      await new Promise<void>((resolve) => setImmediate(resolve));
      return new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }] }), { headers: { "content-type": "application/json" } });
    }));
    const auth = { apiKey: encodeCodexKey({ accessToken: "fixture-access-token", accountId: "fixture-account" }) };
    const send = (session: string, model: string) => withSessionAffinity(session, () => codexProvider.complete({ model, messages }, auth));
    const identities = ["main-session", "main-session:subagent:one", "main-session:subagent:two", "main-session:auxiliary"];
    await Promise.all(identities.map((session, index) => send(session, index === 0 ? mainModel : "gpt-5.4")));
    await send(identities[1]!, "gpt-5.4");
    await send(identities[1]!, "gpt-5.4-mini");
    expect(new Set(calls.slice(0, 4).map((call) => call.key)).size).toBe(4);
    expect(calls.map((call) => call.key)).toEqual([...identities, identities[1], identities[1]]);
    for (const call of calls) {
      expect(call.session).toBe(call.key);
      expect(call.thread).toBe(call.key);
      expect(call.store).toBe(false);
      expect(call.subagent).toBe(call.key.includes(":subagent:") ? "collab_spawn" : null);
    }
    expect(currentSessionAffinity()).toBeUndefined();
  });

  it("gives unscoped auxiliary operations independent identities and keeps session scope stable", async () => {
    const seen: string[] = [];
    vi.spyOn(getProvider("free"), "complete").mockImplementation(async (request) => {
      seen.push(currentSessionAffinity()!);
      return { text: "done", provider: "free", model: request.model ?? "fixture-model" };
    });
    const request = { provider: "free" as const, model: "free-2/kilo-auto/free", messages, purpose: "auxiliary" as const };
    await completeWithProvider(request);
    await completeWithProvider(request);
    expect(seen[0]).toMatch(/^request-/);
    expect(seen[0]).not.toBe(seen[1]);
    await withSessionAffinity("main-session:auxiliary", () => completeWithProvider({ ...request, purpose: "auxiliary" }));
    await withSessionAffinity("main-session", () => completeWithProvider({ ...request, purpose: "auxiliary" }));
    expect(seen.slice(2)).toEqual(["main-session:auxiliary", "main-session:auxiliary"]);
  });

  it("does not share pending or settled wire preflight state between siblings", async () => {
    const options: ResponsesFirstOptions = {
      providerId: "openai", baseUrl: "https://fixture.test/v1", model: "fixture-model", apiKey: "fixture-key", messages,
    };
    const one = vi.fn(async () => { await new Promise<void>((resolve) => setImmediate(resolve)); return { wire: "responses" as const, extras: "full" as const }; });
    const two = vi.fn(async () => ({ wire: "chat" as const, extras: "full" as const }));
    const first = "main-session:subagent:one";
    const second = "main-session:subagent:two";
    const results = await Promise.all([
      withSessionAffinity(first, () => selectResponsesWire(options, true, one)),
      withSessionAffinity(second, () => selectResponsesWire(options, true, two)),
    ]);
    expect(results.map((result) => result.wire)).toEqual(["responses", "chat"]);
    expect(one).toHaveBeenCalledOnce();
    expect(two).toHaveBeenCalledOnce();
    const unexpected = vi.fn(async () => ({ wire: "chat" as const, extras: "full" as const }));
    const again = await withSessionAffinity(first, () => selectResponsesWire(options, true, unexpected));
    expect(again.wire).toBe("responses");
    expect(unexpected).not.toHaveBeenCalled();
  });
});
