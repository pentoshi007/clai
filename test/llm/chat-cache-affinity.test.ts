import { describe, expect, it } from "vitest";
import { buildChatBody } from "../../src/llm/wire/chat-body.js";

const conversation = [
  { role: "user" as const, content: "hello" },
  { role: "assistant" as const, content: "hi" },
  { role: "user" as const, content: "hello again" },
];

function chatBody(providerId: "explabs" | "bynara"): Record<string, unknown> {
  return JSON.parse(
    buildChatBody({
      providerId,
      model: "deepseek-v4-flash-0731",
      messages: conversation,
      stream: true,
    }),
  ) as Record<string, unknown>;
}

describe("chat completions prompt cache affinity", () => {
  it("sends prompt_cache_key for explabs", () => {
    const body = chatBody("explabs");
    expect(typeof body.prompt_cache_key).toBe("string");
    expect(String(body.prompt_cache_key).length).toBeGreaterThan(0);
  });

  it("derives a stable key for identical conversations", () => {
    expect(chatBody("explabs").prompt_cache_key).toBe(
      chatBody("explabs").prompt_cache_key,
    );
  });

  it("does not send prompt_cache_key for providers without affinity", () => {
    expect(chatBody("bynara").prompt_cache_key).toBeUndefined();
  });
});
