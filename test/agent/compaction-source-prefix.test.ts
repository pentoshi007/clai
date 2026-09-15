import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import { compactionSourcePrefixEnd } from "../../src/agent/context/compaction-source-prefix.js";
import { compactMessagesWithSummary } from "../../src/agent/context-manager.js";
import { estimateMessagesTokens } from "../../src/agent/request-accounting.js";

describe("cacheable compaction source prefix", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "Stable system" },
    { role: "user", content: "Read the file" },
    { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "fs.read", args: { path: "index.ts" } }] },
    { role: "tool", toolCallId: "call-1", name: "fs.read", content: "file data" },
    { role: "assistant", content: "The file was read" },
    { role: "user", content: "Continue" },
  ];

  it("backs up to the tool call when the result would not fit", () => {
    const prompt = "Summarize";
    const budgetTokens = estimateMessagesTokens([
      ...messages.slice(0, 3),
      { role: "user", content: prompt },
    ]);
    expect(compactionSourcePrefixEnd({ messages, start: 1, tailStart: 4, prompt, budgetTokens })).toBe(2);
  });

  it("keeps the complete tool group when it fits", () => {
    const prompt = "Summarize";
    const budgetTokens = estimateMessagesTokens([
      ...messages.slice(0, 4),
      { role: "user", content: prompt },
    ]);
    expect(compactionSourcePrefixEnd({ messages, start: 1, tailStart: 4, prompt, budgetTokens })).toBe(4);
  });

  it("does not select an empty prefix or exceed the budget", () => {
    expect(compactionSourcePrefixEnd({ messages, start: 1, tailStart: 4, prompt: "Summarize", budgetTokens: 1 })).toBeUndefined();
  });

  it("summarizes one original prefix and retains every unsummarized turn", async () => {
    const history: ChatMessage[] = [messages[0]!];
    for (let turn = 0; turn < 12; turn += 1) {
      history.push(
        { role: "user", content: `request ${turn}: ${"x".repeat(1000)}` },
        { role: "assistant", content: `answer ${turn}: ${"y".repeat(1000)}` },
      );
    }
    const original = structuredClone(history);
    let sent: readonly ChatMessage[] | undefined;
    let calls = 0;
    const result = await compactMessagesWithSummary(history, async (prompt, stage) => {
      calls += 1;
      sent = stage?.sourceMessages;
      expect(sent).toBeDefined();
      expect(sent).toEqual(history.slice(0, sent!.length));
      expect(estimateMessagesTokens([...sent!, { role: "user", content: prompt }])).toBeLessThanOrEqual(2500);
      return "## Work\nEarlier requests were completed.\n## Remaining\nContinue the retained turns.";
    }, { budgetTokens: 0, keepRecent: 2, singleAdmission: true, singlePassInputBudgetTokens: 2500 });
    expect(calls).toBe(1);
    expect(result.strategy).toBe("emergency_prefix_slice");
    expect(sent!.length).toBeGreaterThan(1);
    expect(result.messages.slice(2)).toEqual(history.slice(sent!.length));
    expect(history).toEqual(original);
  });
});
