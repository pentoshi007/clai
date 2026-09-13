import { describe, expect, it } from "vitest";
import { buildAnthropicBody } from "../../../src/llm/anthropic.js";
import type { ChatMessage } from "../../../src/types.js";

const CACHE_LOOKBACK_BLOCKS = 20;

type Block = { type: string; text?: string; cache_control?: unknown };
type Body = {
  system: Block[];
  messages: Array<{ role: string; content: string | Block[] }>;
};

function body(messages: ChatMessage[]): Body {
  return JSON.parse(buildAnthropicBody({
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    messages,
  }, false)) as Body;
}

function blocks(payload: Body): Block[] {
  return payload.messages.flatMap((message) => typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content);
}

function markedIndexes(payload: Body): number[] {
  return blocks(payload)
    .map((block, index) => (block.cache_control ? index : -1))
    .filter((index) => index >= 0);
}

function stripMarkers(list: Block[]): Block[] {
  return list.map((block) => {
    const copy: Record<string, unknown> = { ...block };
    delete copy.cache_control;
    return copy as Block;
  });
}

const INSTRUCTIONS: ChatMessage = {
  role: "system",
  content: "Stable instructions.\n".repeat(400),
};

describe("Anthropic conversation cache breakpoint placement", () => {
  it("marks the newest stable block of a short conversation", () => {
    const payload = body([
      INSTRUCTIONS,
      { role: "user", content: "read the manifest" },
      { role: "assistant", content: "reading now" },
    ]);
    const content = blocks(payload);
    expect(content.at(-1)).toHaveProperty("cache_control");
  });

  it("keeps a prior turn's written prefix reachable by cache lookup", () => {
    const firstTurn: ChatMessage[] = [
      INSTRUCTIONS,
      { role: "user", content: "audit the wire layer" },
    ];
    const previousBlocks = blocks(body(firstTurn));
    const previous = previousBlocks
      .map((block, index) => (block.cache_control ? index : -1))
      .filter((index) => index >= 0);
    expect(previous.length).toBeGreaterThan(0);

    const grown: ChatMessage[] = [
      ...firstTurn,
      { role: "assistant", content: "inspecting responses-first" },
      { role: "user", content: "keep going" },
    ];
    const next = body(grown);
    expect(stripMarkers(blocks(next)).slice(0, previousBlocks.length))
      .toEqual(stripMarkers(previousBlocks));

    const current = markedIndexes(next);
    for (const written of previous) {
      const reachable = current.some((mark) =>
        mark >= written && mark - written < CACHE_LOOKBACK_BLOCKS,
      );
      expect(reachable).toBe(true);
    }
  });

  it("spaces conversation breakpoints by at least the lookback span", () => {
    const payload = body([
      INSTRUCTIONS,
      ...Array.from({ length: 120 }, (_, index): ChatMessage => ({
        role: index % 2 ? "assistant" : "user",
        content: `message ${index}`,
      })),
    ]);
    const current = markedIndexes(payload);
    expect(current.length).toBeLessThanOrEqual(3);
    for (let index = 1; index < current.length; index += 1) {
      expect(current[index]! - current[index - 1]!).toBeGreaterThanOrEqual(
        CACHE_LOOKBACK_BLOCKS,
      );
    }
  });
});
