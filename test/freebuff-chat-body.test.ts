import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/types.js";
import { buildChatBody } from "../src/llm/http.js";

function parse(options: Parameters<typeof buildChatBody>[0]): Record<string, unknown> {
  return JSON.parse(buildChatBody(options)) as Record<string, unknown>;
}

describe("Freebuff chat body extensions", () => {
  it("adds provider metadata without allowing protected request overrides", () => {
    const body = parse({
      providerId: "openai",
      model: "fixture-model",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      bodyExtras: {
        codebuff_metadata: {
          freebuff_instance_id: "cli:fixture",
          freebuff_multi_session: "1",
          surface: "cli",
        },
      },
    });

    expect(body.codebuff_metadata).toEqual({
      freebuff_instance_id: "cli:fixture",
      freebuff_multi_session: "1",
      surface: "cli",
    });
    expect(body.model).toBe("fixture-model");
    expect(() =>
      buildChatBody({
        model: "fixture-model",
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        bodyExtras: { model: "override" },
      }),
    ).toThrow(/protected field "model"/);
  });

  it("places at most four deterministic ephemeral breakpoints without mutating history", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "instructions" },
      { role: "user", content: "first" },
      { role: "assistant", content: "reply" },
      {
        role: "user",
        content: "look",
        images: [{ mediaType: "image/png", dataBase64: "aGVsbG8=" }],
      },
    ];
    const body = parse({
      providerId: "openai",
      model: "gpt-4o",
      messages,
      stream: true,
      ephemeralCacheBreakpoints: true,
    });
    const wire = body.messages as Array<Record<string, unknown>>;

    expect(wire[0]?.cache_control).toEqual({ type: "ephemeral" });
    expect(wire[1]?.cache_control).toEqual({ type: "ephemeral" });
    expect(wire[2]?.cache_control).toEqual({ type: "ephemeral" });
    const finalParts = wire[3]?.content as Array<Record<string, unknown>>;
    expect(finalParts.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
    expect(messages.every((message) => !("cache_control" in message))).toBe(true);
  });
});
