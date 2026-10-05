import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import {
  compactMessagesWithSummary,
  isCompactionMemoryMessage,
  shouldApplyAutoCompact,
} from "../../src/agent/context-manager.js";
import { acceptPlanImplementCompaction } from "../../src/agent/plan-implement-compact.js";
import {
  hasCompletedConversationTurn,
  RECENT_USER_PROMPT_CHAR_BUDGET,
  recentUserPrompts,
} from "../../src/agent/context/compaction-recent-history.js";
import { assertValidToolProtocol } from "../../src/agent/tool-history.js";

const SUMMARY = [
  "ORIENTATION: Compaction design research is answered; no implementation is pending.",
  "## Latest conversation",
  "- A completed turn can use summary-only history; unfinished requests and tool groups need live messages.",
  "- Replay the successful request prefix and append compaction instructions to preserve cache eligibility.",
  "## Work completed",
  "- Earlier RTK fixes were verified.",
  "## Remaining work",
  "- None requested.",
].join("\n");

function researchHistory(): ChatMessage[] {
  return [
    { role: "system", content: "Stable instructions" },
    { role: "system", content: "Session memory from compacted earlier turns:\n\nRTK fixes completed. An old approval was ambiguous." },
    { role: "user", content: "How does compaction work? Research only." },
    { role: "assistant", content: "The summarizer replays the last successful request." },
    { role: "user", content: "Does reasoning effort affect the cache?" },
    { role: "assistant", content: "The captured reasoning effort must remain compatible." },
    { role: "user", content: "Is the bounded recent-message tail necessary?" },
    { role: "assistant", content: "Reading", toolCalls: [{ id: "read-1", name: "fs.read", args: { path: "src/agent/context/compact-with-summary.ts" } }] },
    { role: "tool", content: "The default tail retains two messages.", toolCallId: "read-1" },
    { role: "assistant", content: "At a completed-turn boundary, summary-only raw history is fine. Retain a live request and complete tool groups during unfinished work." },
    { role: "system", content: "SESSION STATE / WORKING MEMORY\nEarlier RTK plan completed." },
  ];
}

describe("recent conversation memory", () => {
  it("moves the last three real prompts into memory and drops completed raw turns", async () => {
    const history = researchHistory();
    const original = structuredClone(history);
    let source: readonly ChatMessage[] | undefined;
    let instruction = "";
    const result = await compactMessagesWithSummary(history, async (prompt, stage) => {
      source = stage?.sourceMessages;
      instruction = prompt;
      return SUMMARY;
    }, { budgetTokens: 0, singlePassInputBudgetTokens: 200_000 });

    expect(source).toEqual(original);
    expect(source?.every((message, index) => message === history[index])).toBe(true);
    expect(instruction).toContain("## Latest conversation");
    expect(instruction).toContain("An answered question does not authorize implementation");
    expect(instruction).toContain("completed plan does not determine the current conversation topic");
    expect(instruction).toContain("Is the bounded recent-message tail necessary?");
    expect(instruction).toContain("At a completed-turn boundary, summary-only raw history is fine");
    expect(result.messages.map((message) => message.role)).toEqual(["system", "system"]);
    const memory = result.messages.find(isCompactionMemoryMessage)!;
    expect(memory.content).toContain(SUMMARY);
    expect(memory.content).toContain("## Last 3 user prompts");
    expect(memory.content).toContain("> How does compaction work? Research only.");
    expect(memory.content).toContain("> Does reasoning effort affect the cache?");
    expect(memory.content).toContain("> Is the bounded recent-message tail necessary?");
    expect(memory.compaction?.recentUserPrompts).toHaveLength(3);
    expect(history).toEqual(original);
    assertValidToolProtocol(result.messages);
  });

  it("rolls historical prompts forward across persistence and repeated compaction", async () => {
    const first = await compactMessagesWithSummary(researchHistory(), async () => SUMMARY);
    const { saveSession, getSession } = await import("../../src/store/history.js");
    const saved = await saveSession(first.messages, "Recent compaction prompts");
    const record = await getSession(saved.id);
    expect(record).toBeDefined();
    const restored = [...record!.messages];
    restored.push(
      { role: "user", content: "Where is the replay prefix captured?" },
      { role: "assistant", content: "successfulRequestSnapshot captures messages and generation controls." },
    );
    const second = await compactMessagesWithSummary(restored, async () => SUMMARY);
    const prompts = recentUserPrompts(second.messages).map((prompt) => prompt.content);

    expect(prompts).toEqual([
      "Does reasoning effort affect the cache?",
      "Is the bounded recent-message tail necessary?",
      "Where is the replay prefix captured?",
    ]);
    expect(second.messages.filter(isCompactionMemoryMessage)).toHaveLength(1);
    expect(second.messages.every((message) => message.role === "system")).toBe(true);
    const third = await compactMessagesWithSummary(second.messages, async () => SUMMARY);
    expect(recentUserPrompts(third.messages).map((prompt) => prompt.content)).toEqual(prompts);
  });

  it("retains an unfinished request and its complete native tool group", async () => {
    const history = researchHistory().slice(0, 9);
    const result = await compactMessagesWithSummary(history, async () => SUMMARY);

    expect(result.messages.slice(-3)).toEqual(history.slice(-3));
    expect(result.messages.find(isCompactionMemoryMessage)?.content).toContain("Unfinished request (live message retained)");
    expect(result.messages.find(isCompactionMemoryMessage)?.compaction?.recentUserPrompts).toHaveLength(2);
    assertValidToolProtocol(result.messages);
    const continued = [...result.messages, { role: "assistant" as const, content: "Research is answered." }];
    const closed = await compactMessagesWithSummary(continued, async () => SUMMARY);
    expect(recentUserPrompts(closed.messages)).toHaveLength(3);
    expect(closed.messages.every((message) => message.role === "system")).toBe(true);
  });

  it("does not let trailing injected state displace an unfinished tool group", async () => {
    const history = [
      ...researchHistory().slice(0, 9),
      { role: "system" as const, content: "REQUEST CONTEXT\nResearch only." },
      { role: "system" as const, content: "SESSION STATE / WORKING MEMORY\nReading code." },
      { role: "system" as const, content: "PROJECT INSTRUCTIONS\nWorkspace rules." },
    ];
    const result = await compactMessagesWithSummary(history, async () => SUMMARY);

    expect(result.messages).toContainEqual(history[7]);
    expect(result.messages).toContainEqual(history[8]);
    expect(result.messages).toContain(history[6]);
    assertValidToolProtocol(result.messages);
  });

  it("keeps the live request when automatic compaction follows a text response", async () => {
    const history = researchHistory();
    const result = await compactMessagesWithSummary(history, async () => SUMMARY, { preserveActiveTurn: true });

    expect(result.messages.some((message) => message === history[6])).toBe(true);
    expect(result.messages.some((message) => message.role === "assistant")).toBe(true);
    expect(result.messages.find(isCompactionMemoryMessage)?.compaction?.recentUserPrompts).toHaveLength(2);
  });

  it("excludes internal recovery prompts and retains repeated real prompts", async () => {
    const history: ChatMessage[] = [
      { role: "user", content: "Explain caching" },
      { role: "assistant", content: "Caching reuses the prefix." },
      { role: "user", content: "Explain caching" },
      { role: "user", content: "You wrote a message but called NO tool. Continue.", internal: true },
    ];
    const result = await compactMessagesWithSummary(history, async () => SUMMARY);
    const memory = result.messages.find(isCompactionMemoryMessage)!;

    expect(memory.content.match(/> Explain caching/g)).toHaveLength(2);
    expect(memory.content).not.toContain("> You wrote a message");
    expect(result.messages.some((message) => message === history[2])).toBe(true);
  });

  it("bounds historical prompt excerpts while preserving both ends and redacting secrets", async () => {
    const secret = "sk-abcdefgh123456789";
    const prompt = `opening ${secret} ${"evidence ".repeat(20_000)} closing constraint`;
    const result = await compactMessagesWithSummary([
      { role: "user", content: prompt },
      { role: "assistant", content: "Answered the supplied evidence." },
    ], async () => SUMMARY);
    const memory = result.messages.find(isCompactionMemoryMessage)!;
    const historical = memory.compaction?.recentUserPrompts[0]!;

    expect(historical.content.length).toBeLessThanOrEqual(RECENT_USER_PROMPT_CHAR_BUDGET);
    expect(historical.truncated).toBe(true);
    expect(memory.content).toContain("excerpt; middle omitted for length");
    expect(memory.content).toContain("> opening");
    expect(memory.content).toContain("closing constraint");
    expect(JSON.stringify(memory)).not.toContain(secret);
    expect(result.afterTokens).toBeLessThan(5_000);
  });

  it("distinguishes final answers from tools, reasoning-only responses, and recovery prompts", () => {
    expect(hasCompletedConversationTurn(researchHistory())).toBe(true);
    expect(hasCompletedConversationTurn(researchHistory().slice(0, 9))).toBe(false);
    expect(hasCompletedConversationTurn([{ role: "user", content: "Explain" }])).toBe(false);
    expect(hasCompletedConversationTurn([
      { role: "user", content: "Explain" },
      { role: "assistant", content: "<think>still deciding</think>" },
    ])).toBe(false);
    expect(hasCompletedConversationTurn([
      { role: "user", content: "Explain" },
      { role: "user", content: "Continue", internal: true },
      { role: "assistant", content: "Recovering" },
    ])).toBe(false);
  });

  it("keeps user credentials out of the appended prompt section and its metadata", async () => {
    const password = "StagingPassword123!";
    const key = "sk_test_12345678901234567890";
    const result = await compactMessagesWithSummary([
      { role: "user", content: `Check login with password: ${password} and api_key: ${key}` },
      { role: "assistant", content: "Login was checked." },
    ], async () => SUMMARY);
    const memory = result.messages.find(isCompactionMemoryMessage)!;

    expect(JSON.stringify(memory)).not.toContain(password);
    expect(JSON.stringify(memory)).not.toContain(key);
    expect(memory.content).toContain("[redacted user credential]");
  });

  it("does not let quoted prompts make an inadequate model summary pass quality checks", () => {
    const summaryBody = "ok\n\n## Last 3 user prompts\n\n> " + "historical question ".repeat(100);
    const input = {
      summarized: true,
      summaryBody,
      beforeTokens: 40_000,
      afterTokens: 1_000,
      afterMessages: [{ role: "system" as const, content: summaryBody }],
    };
    expect(shouldApplyAutoCompact(input)).toBe(false);
    expect(acceptPlanImplementCompaction(input).accept).toBe(false);
  });
});
