import { describe, expect, it } from "vitest";
import {
  compactMessages,
  compactMessagesWithSummary,
} from "../../src/agent/context-manager.js";
import type { ChatMessage } from "../../src/types.js";

const PROMPT = "done, make sure readme is up to date";
const SUMMARY = [
  "## Work completed",
  "Published the release and verified the existing release checks.",
  "## Remaining work",
  "Continue the previous release workflow.",
].join("\n");

function history(prompt = PROMPT): ChatMessage[] {
  return [
    { role: "system", content: "system prompt" },
    { role: "user", content: "publish the release" },
    { role: "assistant", content: "release evidence ".repeat(2_000) },
    { role: "user", content: prompt },
    { role: "system", content: "REQUEST CONTEXT\nlatest request" },
    { role: "system", content: "PROJECT INSTRUCTIONS\nworkspace rules" },
    { role: "system", content: "ACTIVE PLAN\nrelease follow-up" },
    { role: "system", content: "SESSION STATE / WORKING MEMORY\nrelease" },
  ];
}

const latestPrompt = (messages: readonly ChatMessage[]): ChatMessage | undefined =>
  messages.find((message) => message.role === "user" && message.content === PROMPT);

describe("latest user prompt survives compaction independently of the summary", () => {
  it.each(["direct", "serialized", "prefix-slice"] as const)(
    "retains the submitted prompt after injected system blocks on the %s path",
    async (strategy) => {
      const messages = history();
      const result = await compactMessagesWithSummary(
        messages,
        async () => SUMMARY,
        {
          budgetTokens: 0,
          keepRecent: 2,
          ...(strategy === "direct" ? { singlePassInputBudgetTokens: 200_000 } : {}),
          ...(strategy === "prefix-slice"
            ? { singleAdmission: true, forcePrefixSlice: true, singlePassInputBudgetTokens: 3_000 }
            : {}),
        },
      );

      expect(result.summarized).toBe(true);
      expect(latestPrompt(result.messages)).toEqual(messages[3]);
      expect(result.messages.filter((message) => message.content === PROMPT)).toHaveLength(1);
      expect(result.messages.indexOf(latestPrompt(result.messages)!)).toBeGreaterThan(
        result.messages.findIndex((message) => message.content.includes(SUMMARY)),
      );
    },
  );

  it("does not trim any part of the latest user prompt", async () => {
    const prompt = `start ${"keep these instructions ".repeat(1_000)} end`;
    const messages = history(prompt);
    const result = await compactMessagesWithSummary(messages, async () => SUMMARY, {
      budgetTokens: 0,
      keepRecent: 2,
    });

    expect(result.messages.find((message) => message.role === "user")?.content).toBe(prompt);
  });

  it("does not let an internal recovery prompt displace the user's request", async () => {
    const messages = [
      ...history(),
      { role: "user" as const, content: "continue the previous task", internal: true },
      { role: "assistant" as const, content: "recovering" },
    ];
    const result = await compactMessagesWithSummary(messages, async () => SUMMARY, {
      budgetTokens: 0,
      keepRecent: 2,
    });

    expect(latestPrompt(result.messages)).toEqual(messages[3]);
  });

  it("preserves attached images and prompt metadata", async () => {
    const messages = history();
    messages[3] = {
      role: "user",
      content: PROMPT,
      images: [{ path: "/example/screenshot.png", mediaType: "image/png", dataBase64: "aW1hZ2U=" }],
    };
    const result = await compactMessagesWithSummary(messages, async () => SUMMARY, {
      budgetTokens: 0,
      keepRecent: 2,
    });

    expect(latestPrompt(result.messages)).toEqual(messages[3]);
    expect(messages[3]?.content).toBe(PROMPT);
  });

  it("does not trim the latest prompt even when it already belongs to the recent tail", async () => {
    const prompt = `start ${"keep these instructions ".repeat(3_000)} end`;
    const messages = history(prompt).slice(0, 4);
    const result = await compactMessagesWithSummary(messages, async () => SUMMARY, {
      budgetTokens: 0,
      keepRecent: 2,
    });

    expect(result.messages.filter((message) => message.content === prompt)).toHaveLength(1);
  });

  it("leaves the incoming prompt intact if summary generation fails", async () => {
    const messages = history();
    const original = structuredClone(messages);
    await expect(compactMessagesWithSummary(messages, async () => {
      throw new Error("summary unavailable");
    }, { budgetTokens: 0, keepRecent: 2 })).rejects.toThrow("summary unavailable");

    expect(messages).toEqual(original);
    expect(latestPrompt(messages)).toEqual(original[3]);
  });

  it("retains the latest prompt during mechanical compaction too", () => {
    const messages = history();
    const compacted = compactMessages(messages, { budgetTokens: 0, keepRecent: 2 });

    expect(latestPrompt(compacted)).toEqual(messages[3]);
  });
});
