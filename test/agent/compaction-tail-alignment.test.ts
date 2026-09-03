import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../src/types.js";
import {
  buildCompactionReplayMessages,
  comparableMessage,
  missingHistoryTail,
} from "../../src/agent/compaction/summary-execution.js";

function assistantWithArtifacts(content: string): ChatMessage {
  return {
    role: "assistant",
    content,
    reasoningBlock: { text: "thinking trace" },
    reasoningArtifacts: [
      {
        version: 1,
        kind: "encrypted",
        raw: "opaque-bytes",
        provenance: {
          provider: "free",
          model: "free-1/muse-spark-1.3-contributor-free",
          dialect: "openai-compatible",
        },
        replay: { scope: "tool-turn", persistence: "tool-turn" },
        position: { sequence: 0, placement: "assistant" },
        accounting: { byteLength: 12, estimatedTokens: 4 },
      },
    ],
  };
}

describe("compaction replay tail alignment", () => {
  it("aligns history messages that differ only by replay metadata", () => {
    const snapshot: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const history: ChatMessage[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "hello" },
      assistantWithArtifacts("hi there"),
      { role: "user", content: "follow-up" },
    ];
    expect(missingHistoryTail(snapshot, history)).toEqual([
      { role: "user", content: "follow-up" },
    ]);
  });

  it("still detects genuine content divergence as the tail start", () => {
    const snapshot: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "original answer" },
    ];
    const history: ChatMessage[] = [
      { role: "user", content: "hello" },
      assistantWithArtifacts("edited answer"),
      { role: "user", content: "next" },
    ];
    expect(missingHistoryTail(snapshot, history)).toEqual([
      assistantWithArtifacts("edited answer"),
      { role: "user", content: "next" },
    ]);
  });

  it("builds replay messages without duplicating the aligned prefix", () => {
    const snapshot: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const history: ChatMessage[] = [
      { role: "user", content: "hello" },
      assistantWithArtifacts("hi there"),
      { role: "user", content: "follow-up" },
    ];
    const replayed = buildCompactionReplayMessages(
      {
        provider: "free",
        model: "free-1/muse-spark-1.3-contributor-free",
        messages: snapshot,
      },
      history,
      "summarize",
    );
    expect(replayed.map((message) => message.content)).toEqual([
      "hello",
      "hi there",
      "follow-up",
      "summarize",
    ]);
  });

  it("compares messages independent of images and replay metadata", () => {
    const base: ChatMessage = { role: "assistant", content: "same" };
    expect(comparableMessage(assistantWithArtifacts("same"))).toBe(
      comparableMessage(base),
    );
  });
});
