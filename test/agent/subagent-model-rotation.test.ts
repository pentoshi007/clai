import { describe, expect, it } from "vitest";
import { ProviderError } from "../../src/llm/http.js";
import { markStreamEmittedBytes } from "../../src/llm/stream-progress.js";
import {
  adaptSubagentHistory,
  runSubagentModelRotation,
  type SubagentModelRoute,
} from "../../src/agent/subagents/model-chain.js";
import type { ChatMessage } from "../../src/types.js";

const candidates: SubagentModelRoute[] = [
  { provider: "openai", model: "primary" },
  { provider: "anthropic", model: "fallback" },
];

const failure = (message = "server error") => new ProviderError(message, 500);

async function rotate(
  stream: (route: SubagentModelRoute, attempt: number) => Promise<{ value: string; streamedBytes?: number }>,
  signal = new AbortController().signal,
) {
  return runSubagentModelRotation({ candidates, signal, stream });
}

describe("subagent model rotation", () => {
  it("switches after the second failure and returns the successful route", async () => {
    const calls: string[] = [];
    const result = await rotate(async (route, attempt) => {
      calls.push(`${route.model}:${attempt}`);
      if (route.model === "primary") throw failure();
      return { value: "ok" };
    });
    expect(result).toMatchObject({ value: "ok", index: 1, route: candidates[1] });
    expect(calls).toEqual(["primary:0", "primary:1", "fallback:0"]);
  });

  it("switches on rate limits and throws the final exhausted error", async () => {
    const calls: string[] = [];
    const result = await rotate(async (route, attempt) => {
      calls.push(`${route.model}:${attempt}`);
      if (route.model === "primary") throw new ProviderError("rate limited", 429);
      return { value: "ok" };
    });
    expect(result.value).toBe("ok");
    expect(calls).toEqual(["primary:0", "primary:1", "fallback:0"]);

    await expect(rotate(async (_route, attempt) => {
      throw failure(`failure-${attempt}`);
    })).rejects.toThrow("failure-1");
  });

  it("does not rotate after streamed bytes or after abort", async () => {
    const streamed = new Error("connection closed");
    let calls = 0;
    await expect(rotate(async () => {
      calls += 1;
      throw markStreamEmittedBytes(streamed, 1);
    })).rejects.toBe(streamed);
    expect(calls).toBe(1);

    const controller = new AbortController();
    const pending = rotate(async () => {
      controller.abort(new Error("stop requested"));
      throw failure();
    }, controller.signal);
    await expect(pending).rejects.toThrow("stop requested");
  });

  it("adapts native tool history to fenced history and back", () => {
    const native: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: "original", name: "fs.read", args: { path: "src/a.ts" } }] },
      { role: "tool", name: "fs.read", toolCallId: "original", content: "evidence" },
    ];
    const fenced = adaptSubagentHistory(native, true, false);
    expect(fenced[2]).toMatchObject({ role: "assistant", content: expect.stringContaining('"name":"fs.read"') });
    expect(fenced[2]?.toolCalls).toBeUndefined();
    expect(fenced[3]).toEqual({ role: "user", content: "Untrusted tool result for fs.read:\nevidence" });

    const restored = adaptSubagentHistory(fenced, false, true);
    expect(restored[2]).toMatchObject({ role: "assistant", toolCalls: [{ name: "fs.read", args: { path: "src/a.ts" } }] });
    expect(restored[3]).toMatchObject({ role: "tool", name: "fs.read", content: "evidence" });
  });
});
