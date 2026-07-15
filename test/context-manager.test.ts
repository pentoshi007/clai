import { describe, expect, it } from "vitest";
import {
  compactMessages,
  compactMessagesWithSummary,
  estimateMessagesTokens,
  estimateTokens,
} from "../src/agent/context-manager.js";
import type { ChatMessage } from "../src/types.js";

describe("phase 9 — context manager", () => {
  it("estimateTokens approximates chars / 3.3", () => {
    expect(estimateTokens("a".repeat(100))).toBe(31);
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
      content: `message-${index}-` + "very-long-dummy-content-to-exceed-token-limits-and-make-compaction-worthwhile-".repeat(10),
    }));
    const result = await compactMessagesWithSummary(msgs, async (prompt) => {
      expect(prompt).toContain("nmap -sT localhost");
      expect(prompt).toContain("Commands/tools and results");
      // Visual + older model turns are both fed to the summarizer.
      expect(prompt).toContain("OLDER MODEL TURNS");
      expect(prompt).toContain("message-0-");
      return "The user selected PostgreSQL and implementation remains pending.";
    }, { keepRecent: 8 }, "TOOL/COMMAND: shell.exec\nINPUT: nmap -sT localhost\nOUTPUT/RESULT: port 5000 open");
    expect(result.summarized).toBe(true);
    expect(result.messages[0]?.content).toContain("PostgreSQL");
    expect(result.messages.slice(-8)).toEqual(msgs.slice(-8));
  });

  it("compacts resumed history together with newer turns", async () => {
    // Simulate /history load (older turns) + follow-up chat, then /compact.
    const history: ChatMessage[] = [
      { role: "user", content: "from history: map the network" },
      { role: "assistant", content: "from history: found 3 hosts" },
      { role: "user", content: "new after resume: exploit host A" },
      { role: "assistant", content: "new after resume: shell obtained" },
      { role: "user", content: "new: dump creds" },
      { role: "assistant", content: "new: got hashes" },
    ];
    const visual =
      "USER INTENT/PROMPT:\nfrom history: map the network\n\n---\n\n" +
      "ASSISTANT RESPONSE:\nfrom history: found 3 hosts\n\n---\n\n" +
      "USER INTENT/PROMPT:\nnew after resume: exploit host A";

    let seenPrompt = "";
    const result = await compactMessagesWithSummary(
      history,
      async (prompt) => {
        seenPrompt = prompt;
        return "User goals: map network and exploit host A. Work completed: 3 hosts found, shell, hashes.";
      },
      { budgetTokens: 0, keepRecent: 2 },
      visual,
    );

    expect(result.summarized).toBe(true);
    expect(seenPrompt).toContain("from history: map the network");
    expect(seenPrompt).toContain("new after resume: exploit host A");
    // Older model turns (not in the keepRecent tail) must still be summarized.
    expect(seenPrompt).toMatch(/from history: found 3 hosts|OLDER MODEL TURNS/);
    // keepRecent=2 → last user+assistant preserved verbatim.
    expect(result.messages.slice(-2)).toEqual(history.slice(-2));
    expect(result.messages.some((m) => m.content.includes("User goals: map network"))).toBe(
      true,
    );
  });

  it("throws on summarization failure instead of dumping a fallback transcript", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message-${index}-` + "very-long-dummy-content-to-exceed-token-limits-and-make-compaction-worthwhile-".repeat(10),
    }));
    await expect(
      compactMessagesWithSummary(msgs, async () => {
        throw new Error("offline");
      }, { keepRecent: 4 }),
    ).rejects.toThrow("offline");
  });
});
