import { describe, expect, it } from "vitest";
import { buildAnthropicBody } from "../src/llm/anthropic.js";
import type { ChatMessage } from "../src/types.js";

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
  }, false));
}

function blocks(payload: Body): Block[] {
  return payload.messages.flatMap((message) => typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : message.content);
}

const system: ChatMessage = { role: "system", content: "Stable instructions.\n".repeat(400) };

describe("Anthropic cache lookup coverage", () => {
  it.each([20, 21, 30, 100])("retains a searchable prior prefix across a %i-call parallel tool batch", (count) => {
    const initial: ChatMessage[] = [system, { role: "user", content: "inspect the files" }];
    const calls = Array.from({ length: count }, (_, index) => ({
      id: `call-${index}`,
      name: "fs.read",
      args: { path: `${index}.ts` },
    }));
    const messages: ChatMessage[] = [
      ...initial,
      { role: "assistant", content: "checking", toolCalls: calls },
      ...calls.map((call): ChatMessage => ({
        role: "tool", toolCallId: call.id, content: `result ${call.id}`, ok: true,
      })),
      { role: "system", content: "SESSION STATE / WORKING MEMORY\nupdated" },
    ];
    const before = structuredClone(messages);
    const first = blocks(body(initial));
    const next = body(messages);
    const nextBlocks = blocks(next);
    expect(nextBlocks.slice(0, first.length)).toEqual(first);
    expect(nextBlocks[0]!.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
    expect(nextBlocks.filter((block) => block.cache_control)).toHaveLength(3);
    expect([...next.system, ...nextBlocks].filter((block) => block.cache_control)).toHaveLength(4);
    expect(nextBlocks.at(-1)).not.toHaveProperty("cache_control");
    for (const call of calls) expect(JSON.stringify(next)).toContain(`result ${call.id}`);
    expect(messages).toEqual(before);
  });

  it("keeps a previous prefix searchable across an image-heavy revision", () => {
    const initial: ChatMessage[] = [system, { role: "user", content: "inspect the project" }];
    const images = Array.from({ length: 25 }, (_, index) => ({
      mediaType: "image/png" as const,
      dataBase64: Buffer.from(`image ${index}`).toString("base64"),
    }));
    const messages: ChatMessage[] = [
      ...initial,
      { role: "assistant", content: "ready for revisions" },
      { role: "user", content: "apply these revisions", images },
      { role: "system", content: "REQUEST CONTEXT\nrevision instructions" },
    ];
    const before = structuredClone(messages);
    const first = blocks(body(initial));
    const next = body(messages);
    const content = blocks(next);
    const previousBoundary = first.length - 1;
    const reachable = content.some((block, index) =>
      block.cache_control && index >= previousBoundary && index - previousBoundary < 20,
    );
    expect(reachable).toBe(true);
    expect(content.filter((block) => block.type === "image")).toHaveLength(images.length);
    expect([...next.system, ...content].filter((block) => block.cache_control).length).toBeLessThanOrEqual(4);
    expect(content.at(-1)).not.toHaveProperty("cache_control");
    expect(messages).toEqual(before);
  });

  it("does not let an empty assistant tail prevent caching the preceding context", () => {
    const payload = body([
      system,
      { role: "user", content: "cache this request" },
      { role: "assistant", content: "" },
    ]);
    const marked = blocks(payload).filter((block) => block.cache_control);
    expect(marked).toEqual([{
      type: "text", text: "cache this request", cache_control: { type: "ephemeral", ttl: "1h" },
    }]);
  });

  it("keeps the total breakpoint count bounded over a long session", () => {
    const payload = body([
      system,
      ...Array.from({ length: 200 }, (_, index): ChatMessage => ({
        role: index % 2 ? "assistant" : "user", content: `message ${index}`,
      })),
    ]);
    const content = blocks(payload);
    expect([...payload.system, ...content].filter((block) => block.cache_control)).toHaveLength(4);
    expect(content.at(-1)).toHaveProperty("cache_control");
    expect(content).toHaveLength(200);
  });
});
