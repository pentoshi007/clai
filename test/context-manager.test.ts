import { describe, expect, it } from "vitest";
import {
  compactMessages,
  compactMessagesWithSummary,
  estimateMessagesTokens,
  estimateTokens,
} from "../src/agent/context-manager.js";
import type { ChatMessage } from "../src/types.js";

describe("phase 9 — context manager", () => {
  it("estimateTokens approximates chars / 4", () => {
    expect(estimateTokens("a".repeat(100))).toBe(25);
    expect(estimateTokens("")).toBe(0);
  });

  it("estimateMessagesTokens sums per-message", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "x".repeat(40) },
      { role: "user", content: "y".repeat(40) },
    ];
    expect(estimateMessagesTokens(msgs)).toBeGreaterThanOrEqual(20);
  });

  it("compactMessages keeps system prompt and trailing messages intact", () => {
    const big = "x".repeat(120_000);
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "first" },
      { role: "assistant", content: big },
      { role: "tool", content: big },
      { role: "user", content: "second" },
      { role: "assistant", content: "second-answer" },
      { role: "user", content: "third" },
      { role: "assistant", content: "third-answer" },
      { role: "user", content: "fourth" },
      { role: "assistant", content: "fourth-answer" },
    ];
    const out = compactMessages(msgs, { budgetTokens: 1_000, keepRecent: 4 });
    expect(out.length).toBeLessThan(msgs.length);
    // System prompt preserved
    expect(out[0]?.role).toBe("system");
    expect(out[0]?.content).toBe("SYS");
    // Memo inserted as second message
    expect(out[1]?.role).toBe("system");
    expect(out[1]?.content).toMatch(/Earlier turns/);
    // Last 4 messages preserved
    const tail = out.slice(-4);
    expect(tail.map((m) => m.content)).toEqual([
      "third",
      "third-answer",
      "fourth",
      "fourth-answer",
    ]);
  });

  it("compactMessages is a no-op when under budget", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
    ];
    const out = compactMessages(msgs, { budgetTokens: 100_000 });
    expect(out).toEqual(msgs);
  });

  it("creates semantic memory while preserving recent messages", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message-${index}`,
    }));
    const result = await compactMessagesWithSummary(msgs, async (prompt) => {
      expect(prompt).toContain("nmap -sT localhost");
      expect(prompt).toContain("Commands/tools and results");
      return "The user selected PostgreSQL and implementation remains pending.";
    }, {}, "TOOL/COMMAND: shell.exec\nINPUT: nmap -sT localhost\nOUTPUT/RESULT: port 5000 open");
    expect(result.summarized).toBe(true);
    expect(result.messages[0]?.content).toContain("PostgreSQL");
    expect(result.messages.slice(-8)).toEqual(msgs.slice(-8));
  });

  it("falls back locally when model summarization fails", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message-${index}`,
    }));
    const result = await compactMessagesWithSummary(msgs, async () => {
      throw new Error("offline");
    }, { keepRecent: 4 });
    expect(result.summarized).toBe(false);
    expect(result.after).toBeLessThan(result.before);
    expect(result.messages.slice(-4)).toEqual(msgs.slice(-4));
  });
});
