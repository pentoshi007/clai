import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionRequest, CompletionResult } from "../../src/types.js";
import type { LlmProvider, ProviderAuth } from "../../src/llm/provider.js";
import { currentSessionAffinity, withSessionAffinity } from "../../src/llm/session-affinity.js";
import { ProviderError } from "../../src/llm/http.js";

const state = vi.hoisted(() => ({
  keys: [{ id: "one", value: "key-one", disabled: false }, { id: "two", value: "key-two", disabled: false }],
  endpoints: ["https://one.example/v1", "https://two.example/v1"],
  activeKey: 0,
  activeEndpoint: 0,
  disabledEndpoints: [] as string[],
  dispatch: vi.fn(),
  saveKey: vi.fn(),
  saveEndpoint: vi.fn(),
}));

vi.mock("../../src/store/keys.js", () => ({
  getProviderKeys: async () => ({ keys: state.keys, activeIndex: state.activeKey, source: "fallback" }),
  markProviderKeySuccess: async (_provider: string, index: number) => {
    state.activeKey = index;
    state.saveKey(index);
  },
}));
vi.mock("../../src/store/config.js", () => ({
  providerUsesEndpoints: () => true,
  getProviderEndpoints: () => ({ urls: state.endpoints, activeIndex: state.activeEndpoint, disabledUrls: state.disabledEndpoints }),
  getActiveProviderEndpoint: () => state.endpoints[state.activeEndpoint],
  setActiveProviderEndpoint: (_provider: string, index: number) => {
    state.activeEndpoint = index;
    state.saveEndpoint(index);
  },
}));
vi.mock("../../src/llm/routing/provider-selection.js", () => ({
  authForSlot: (_provider: string, value: string) => ({ apiKey: value, baseUrl: state.endpoints[state.activeEndpoint] }),
}));
vi.mock("../../src/llm/routing/attempt-complete.js", () => ({ tryCompleteOnce: (...args: unknown[]) => state.dispatch(...args) }));
vi.mock("../../src/llm/routing/attempt-stream.js", () => ({ tryStreamOnce: (...args: unknown[]) => state.dispatch(...args) }));

import { runWithKeyRotation } from "../../src/llm/routing/key-rotation.js";

const result: CompletionResult = { provider: "modal", model: "test", text: "ok" };
const request: CompletionRequest = { provider: "modal", model: "test", messages: [{ role: "user", content: "inspect" }] };

function dispatch(session: string, mode: "complete" | "stream" = "complete", singleDispatch = false) {
  return withSessionAffinity(session, () => runWithKeyRotation({
    providerId: "modal", provider: {} as LlmProvider, request, model: "test", mode,
    emitKey: () => {}, initialAttemptReason: "initial", maxRetries: 0, singleDispatch,
  }));
}

beforeEach(() => {
  state.activeKey = 0;
  state.activeEndpoint = 0;
  state.disabledEndpoints = [];
  state.endpoints = ["https://one.example/v1", "https://two.example/v1"];
  state.keys = [{ id: "one", value: "key-one", disabled: false }, { id: "two", value: "key-two", disabled: false }];
  state.dispatch.mockReset().mockResolvedValue(result);
  state.saveKey.mockReset();
  state.saveEndpoint.mockReset();
});

describe("orchestration cache route isolation", () => {
  it.each(["complete", "stream"] as const)("keeps parent, siblings and restarted children independent (%s)", async (mode) => {
    const parent = randomUUID();
    const one = `${parent}:subagent:one`;
    const two = `${parent}:subagent:two`;
    const seen: { session: string; auth: ProviderAuth }[] = [];
    state.dispatch.mockImplementation(async (_provider, _id, _request, _model, auth: ProviderAuth) => {
      const session = currentSessionAffinity()!;
      seen.push({ session, auth });
      if (session === one && auth.baseUrl === state.endpoints[0]) throw new ProviderError("unavailable", 503);
      return result;
    });
    await dispatch(parent, mode);
    await Promise.all([dispatch(one, mode), dispatch(two, mode), dispatch(parent, mode)]);
    expect(state.activeKey).toBe(0);
    expect(state.activeEndpoint).toBe(0);
    expect(state.saveKey).toHaveBeenCalledTimes(2);
    expect(state.saveEndpoint).not.toHaveBeenCalled();
    for (const session of [parent, two]) {
      expect(seen.filter((entry) => entry.session === session).every((entry) => entry.auth.apiKey === "key-one" && entry.auth.baseUrl === state.endpoints[0])).toBe(true);
    }
    expect(seen.filter((entry) => entry.session === one).at(-1)?.auth).toEqual({ apiKey: "key-two", baseUrl: state.endpoints[1] });
    state.activeKey = 1;
    state.activeEndpoint = 1;
    seen.length = 0;
    await Promise.all([dispatch(one, mode), dispatch(two, mode), dispatch(parent, mode)]);
    expect(seen).toEqual(expect.arrayContaining([
      { session: one, auth: { apiKey: "key-two", baseUrl: state.endpoints[1] } },
      { session: two, auth: { apiKey: "key-one", baseUrl: state.endpoints[0] } },
      { session: parent, auth: { apiKey: "key-two", baseUrl: state.endpoints[1] } },
    ]));
    expect(seen).toHaveLength(3);
  });

  it("pins stable slot IDs and endpoint URLs rather than list positions", async () => {
    const session = `${randomUUID()}:subagent:one`;
    await dispatch(session);
    state.keys.reverse();
    state.endpoints.reverse();
    await dispatch(session, "complete", true);
    expect(state.dispatch.mock.calls.at(-1)?.[4]).toEqual({ apiKey: "key-one", baseUrl: "https://one.example/v1" });
    expect(state.saveKey).not.toHaveBeenCalled();
    expect(state.saveEndpoint).not.toHaveBeenCalled();
  });

  it("does not reuse disabled or removed routes", async () => {
    const session = `${randomUUID()}:subagent:one`;
    await dispatch(session);
    state.keys[0]!.disabled = true;
    state.disabledEndpoints = [state.endpoints[0]!];
    await dispatch(session);
    expect(state.dispatch.mock.calls.at(-1)?.[4]).toEqual({ apiKey: "key-two", baseUrl: "https://two.example/v1" });
    state.keys.pop();
    state.keys[0]!.disabled = false;
    state.endpoints.pop();
    state.disabledEndpoints = [];
    await dispatch(session);
    expect(state.dispatch.mock.calls.at(-1)?.[4]).toEqual({ apiKey: "key-one", baseUrl: "https://one.example/v1" });
  });

  it("isolates auxiliary routes without changing interactive selections", async () => {
    const session = `${randomUUID()}:auxiliary`;
    await dispatch(session);
    state.activeKey = 1;
    state.activeEndpoint = 1;
    await dispatch(session);
    expect(state.dispatch.mock.calls.at(-1)?.[4]).toEqual({ apiKey: "key-one", baseUrl: "https://one.example/v1" });
    expect(state.saveKey).not.toHaveBeenCalled();
    expect(state.saveEndpoint).not.toHaveBeenCalled();
  });

  it("never rotates endpoints during a single dispatch", async () => {
    const session = `${randomUUID()}:subagent:one`;
    state.dispatch.mockRejectedValue(new ProviderError("unauthorized", 401));
    await expect(dispatch(session, "complete", true)).rejects.toThrow("unauthorized");
    expect(state.dispatch).toHaveBeenCalledOnce();
    expect(state.saveKey).not.toHaveBeenCalled();
    expect(state.saveEndpoint).not.toHaveBeenCalled();
  });
});
