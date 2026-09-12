import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage, CompletionRequest } from "../../src/types.js";
import { sessionCacheAffinityKey } from "../../src/llm/cache-affinity.js";
import { completeWithProvider, streamWithProvider } from "../../src/llm/router.js";
import { currentSessionAffinity, withSessionAffinity } from "../../src/llm/session-affinity.js";
import { resetResponsesWireStatesForTesting } from "../../src/llm/wire/responses-first.js";
import { installTransport, type RecordedRequest } from "../conformance/fake-transport.js";
import { buildWireResponse } from "../conformance/wire-fixtures.js";

vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async (provider: string) => ({
      keys: [{ id: "env", value: `sk-${provider}-testkey`, createdAt: 0 }],
      activeIndex: 0,
      source: "env" as const,
    }),
  };
});

const routes = [
  { provider: "openai", model: "gpt-5" },
  { provider: "explabs", model: "gpt-5.6-luna" },
  { provider: "explabs", model: "deepseek-v4-flash-0731" },
  { provider: "meta", model: "muse-spark" },
] as const;

const messages: ChatMessage[] = [
  { role: "system", content: "Stable system rules" },
  { role: "user", content: "Investigate the same assignment" },
  { role: "assistant", content: "Initial findings" },
  { role: "user", content: "Continue the investigation" },
];

function body(request: RecordedRequest): Record<string, unknown> {
  return request.body as Record<string, unknown>;
}

function wireMessages(request: RecordedRequest): unknown[] {
  return (body(request).input ?? body(request).messages) as unknown[];
}

function captureTransport() {
  return installTransport((request) => buildWireResponse(
    request.url.endsWith("/responses") ? "meta_responses" : "chat_completions",
    body(request).stream ? "stream" : "complete",
    "reasoning",
    String(body(request).model),
  ));
}

beforeEach(() => resetResponsesWireStatesForTesting());
afterEach(() => {
  resetResponsesWireStatesForTesting();
  vi.unstubAllGlobals();
});

describe.each(routes)("$provider $model transport cache affinity", (route) => {
  it.each(["complete", "stream"] as const)(
    "isolates concurrent children and auxiliary %s requests without changing the main prefix",
    async (mode) => {
      const transport = captureTransport();
      const request: CompletionRequest = {
        ...route,
        messages,
        thinking: { enabled: true, effort: "high" },
      };
      const dispatch = (next: CompletionRequest) => mode === "stream"
        ? streamWithProvider(next, () => {}, { singleDispatch: true })
        : completeWithProvider(next, { singleDispatch: true });
      const followUp: CompletionRequest = {
        ...request,
        messages: [...messages, { role: "user", content: "Next follow-up" }],
      };
      await withSessionAffinity("transport-parent", async () => {
        await dispatch(request);
        await Promise.all([
          ...["one", "two"].map((id) => withSessionAffinity(
            `transport-parent:subagent:${id}`,
            () => dispatch({ ...request, thinking: { enabled: true, effort: "minimal" } }),
          )),
          dispatch({ ...request, purpose: "auxiliary" }),
          dispatch(followUp),
        ]);
        expect(currentSessionAffinity()).toBe("transport-parent");
        await dispatch({ ...followUp, purpose: "auxiliary" });
        await dispatch({
          ...followUp,
          purpose: "compaction",
          messages: [...followUp.messages, { role: "user", content: "Compact this history" }],
        });
      });
      expect(currentSessionAffinity()).toBeUndefined();

      const requestsFor = (session: string) => transport.generations.filter(
        (entry) => entry.headers["x-clai-session"] === session,
      );
      const main = requestsFor("transport-parent");
      expect(main).toHaveLength(3);
      expect(new Set(main.map((entry) => body(entry).prompt_cache_key)).size).toBe(1);
      expect(body(main[0]!).prompt_cache_key).toBe(sessionCacheAffinityKey("transport-parent"));
      expect(wireMessages(main[1]!).slice(0, wireMessages(main[0]!).length)).toEqual(wireMessages(main[0]!));
      expect(wireMessages(main[2]!).slice(0, wireMessages(main[1]!).length)).toEqual(wireMessages(main[1]!));

      const scopes = [
        "transport-parent",
        "transport-parent:subagent:one",
        "transport-parent:subagent:two",
        "transport-parent:auxiliary",
      ];
      const scoped = scopes.map((scope) => {
        const entries = requestsFor(scope);
        expect(entries.length).toBeGreaterThan(0);
        expect(new Set(entries.map((entry) => body(entry).prompt_cache_key)).size).toBe(1);
        for (const entry of entries) {
          expect(entry.headers["x-session-affinity"]).toBe(sessionCacheAffinityKey(scope));
        }
        return entries[0]!;
      });
      expect(new Set(scoped.map((entry) => body(entry).prompt_cache_key)).size).toBe(4);
      expect(new Set(scoped.map((entry) => entry.headers["x-session-affinity"])).size).toBe(4);
      for (const probe of transport.generations.filter(
        (entry) => entry.headers["x-clai-session"]?.startsWith("preflight-"),
      )) {
        expect(scoped.map((entry) => body(entry).prompt_cache_key)).not.toContain(body(probe).prompt_cache_key);
      }
    },
  );

  it("isolates auxiliary requests outside an active session", async () => {
    const transport = captureTransport();
    const request: CompletionRequest = { ...route, messages };
    await completeWithProvider(request, { singleDispatch: true });
    await completeWithProvider({ ...request, purpose: "auxiliary" }, { singleDispatch: true });
    const generations = transport.generations.filter(
      (entry) => !entry.headers["x-clai-session"]?.startsWith("preflight-"),
    );
    expect(generations).toHaveLength(2);
    expect(body(generations[1]!).prompt_cache_key).not.toBe(body(generations[0]!).prompt_cache_key);
    expect(currentSessionAffinity()).toBeUndefined();
  });
});
