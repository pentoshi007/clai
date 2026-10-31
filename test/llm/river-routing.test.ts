import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompletionResult } from "../../src/types.js";
import type { ProviderKeyEvent } from "../../src/llm/key-rotation.js";
import { clearModelCatalogFacts, resetReasoningKnowledge } from "../../src/llm/capabilities.js";
import { completion, json, REQUEST, sse, stubRiverFetch } from "./river-fixtures.js";

const state = vi.hoisted(() => ({
  keys: [
    { id: "one", value: "rv_rotation_first", disabled: false },
    { id: "two", value: "rv_rotation_second", disabled: false },
  ],
  saveKey: vi.fn(),
}));
vi.mock("../../src/store/keys.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/keys.js")>();
  return {
    ...actual,
    getProviderKeys: async () => ({ keys: state.keys, activeIndex: 0, source: "storage" as const }),
    markProviderKeySuccess: state.saveKey,
  };
});
vi.mock("../../src/store/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/store/config.js")>();
  return {
    ...actual,
    getProviderEndpoints: () => ({ urls: [], activeIndex: 0 }),
    getActiveProviderEndpoint: () => "",
  };
});
import { runWithKeyRotation } from "../../src/llm/routing/key-rotation.js";
import { riverProvider } from "../../src/llm/river.js";

beforeEach(() => {
  state.saveKey.mockReset().mockResolvedValue(undefined);
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});
afterEach(() => {
  vi.unstubAllGlobals();
  clearModelCatalogFacts();
  resetReasoningKnowledge();
});

describe("River shared key lifecycle", () => {
  it.each(["complete", "stream"] as const)("rotates a rejected key and preserves provider/model identity (%s)", async (mode) => {
    const used: string[] = [];
    const events: ProviderKeyEvent[] = [];
    stubRiverFetch(vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const credential = new Headers(init?.headers).get("authorization") ?? "";
      if (credential.endsWith(state.keys[0]!.value)) return json({ error: "Invalid API key" }, 401);
      if (String(input).endsWith("/models")) return json({ data: [{ id: REQUEST.model }] });
      used.push(credential);
      return mode === "complete" ? completion() : sse([{ choices: [{ delta: { content: "Answer" }, finish_reason: "stop" }] }]);
    }) as unknown as typeof fetch);
    const result = await runWithKeyRotation<CompletionResult>({
      providerId: "river", provider: riverProvider, request: REQUEST, model: REQUEST.model!,
      emitKey: (event) => events.push(event), mode, initialAttemptReason: "initial", maxRetries: 0,
      onToken: () => {},
    });
    expect(result).toMatchObject({ provider: "river", model: REQUEST.model, text: "Answer" });
    expect(used).toEqual([`Bearer ${state.keys[1]!.value}`]);
    expect(events.some((event) => event.type === "switch")).toBe(true);
    expect(state.saveKey).toHaveBeenCalledWith("river", 1);
  });
});
