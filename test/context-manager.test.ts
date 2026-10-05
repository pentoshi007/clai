import { describe, expect, it } from "vitest";
import {
  compactMessages,
  compactMessagesWithSummary,
  estimateMessagesTokens,
  estimateTokens,
  shouldApplyAutoCompact,
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

  it("creates semantic memory while preserving messages in an active turn", async () => {
    const msgs: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message-${index}-` + "very-long-dummy-content-to-exceed-token-limits-and-make-compaction-worthwhile-".repeat(10),
    }));
    const result = await compactMessagesWithSummary(msgs, async (prompt) => {
      expect(prompt).toContain("nmap -sT localhost");
      expect(prompt).toMatch(/Commands\/tools and results|## Commands\/tools/);
      expect(prompt).toContain("OLDER MODEL TURNS");
      expect(prompt).toContain("message-0-");
      expect(prompt).toContain("## User goals");
      return "The user selected PostgreSQL and implementation remains pending.";
    }, { keepRecent: 8, preserveActiveTurn: true }, "TOOL/COMMAND: shell.exec\nINPUT: nmap -sT localhost\nOUTPUT/RESULT: port 5000 open");
    expect(result.summarized).toBe(true);
    expect(result.messages[0]?.content).toContain("PostgreSQL");
    expect(result.messages.slice(-8)).toEqual(msgs.slice(-8));
  });

  it("does not send duplicate model history when the visual transcript covers it", async () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "inspect the repository" },
      { role: "assistant", content: "I inspected package.json." },
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent reply" },
    ];
    let prompt = "";
    await compactMessagesWithSummary(
      msgs,
      async (value) => {
        prompt = value;
        return "## Work completed\nRepository inspected.\n## Remaining work\nContinue.";
      },
      { budgetTokens: 0, keepRecent: 2 },
      "USER INTENT/PROMPT:\ninspect the repository\n\nASSISTANT RESPONSE:\nI inspected package.json.\n\nUSER INTENT/PROMPT:\nrecent request\n\nASSISTANT RESPONSE:\nrecent reply",
    );

    expect(prompt).toContain("inspect the repository");
    expect(prompt).not.toContain("OLDER MODEL TURNS");
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
    expect(seenPrompt).toMatch(/from history: found 3 hosts|OLDER MODEL TURNS/);
    expect(seenPrompt).toContain("new: got hashes");
    expect(result.messages.every((message) => message.role === "system")).toBe(true);
    expect(result.messages[0]?.content).toContain("## Last 3 user prompts");
    expect(result.messages[0]?.content).toContain("> new: dump creds");
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

  it("prefers soft 16–20k band via progressive trim, without hard-fail ceiling", async () => {
    // Older turns summarize; recent tail kept; oversized dumps soft-trimmed
    // toward POST_COMPACT_SOFT_UPPER_BAND — never drop messages to hit a number.
    const fatTool = "x".repeat(20_000);
    const msgs: ChatMessage[] = [
      // ~6k tokens system (realistic-ish; full agent.md is ~8k)
      { role: "system", content: "SYS " + "s".repeat(20_000) },
      { role: "user", content: "assess target.example" },
    ];
    for (let i = 0; i < 20; i += 1) {
      msgs.push({
        role: "assistant",
        content: `step ${i}`,
        toolCalls: [
          {
            id: `c${i}`,
            name: "http.fetch",
            args: { url: `https://t.example/${i}` },
          },
        ],
      });
      msgs.push({
        role: "tool",
        content: fatTool,
        toolCallId: `c${i}`,
        name: "http.fetch",
        ok: true,
      });
    }
    msgs.push({ role: "user", content: "continue" });
    msgs.push({ role: "assistant", content: "working on next probes" });

    const before = estimateMessagesTokens(msgs);
    expect(before).toBeGreaterThan(80_000);

    const result = await compactMessagesWithSummary(
      msgs,
      async () =>
        "## User goals\nAssess target.example\n## Work completed\nMany http.fetch probes; stack nginx.\n## Remaining work\nAuth testing\n## Current state\nRecon mid\n## Decisions and constraints\nRemote only\n## Commands/tools and results\nhttp.fetch GETs\n## Open risks / failures\nnone",
      { budgetTokens: 0, keepRecent: 5, preserveActiveTurn: true },
    );

    expect(result.summarized).toBe(true);
    expect(result.afterTokens).toBeLessThan(before);
    expect(result.afterTokens).toBeLessThan(before * 0.5);
    // Soft-trim oversized dumps; keep non-empty tool results and recent user.
    const toolMsgs = result.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    for (const t of toolMsgs) {
      expect(t.content.length).toBeGreaterThan(0);
      expect(t.content.length).toBeLessThan(fatTool.length);
    }
    expect(result.messages.some((m) => m.role === "user" && m.content === "continue")).toBe(
      true,
    );
    // Prefer band when system is not itself huge; with ~6k system + memory +
    // lean tail we should land well under the pre-fix ~50k fat-tail regime.
    expect(result.afterTokens).toBeLessThan(40_000);
  });

  it("shouldApplyAutoCompact rejects stubs and non-reductions only", () => {
    // Near-empty memory after large history → amnesia risk.
    expect(
      shouldApplyAutoCompact({
        summarized: true,
        summaryBody: "x".repeat(50),
        beforeTokens: 50_000,
        afterTokens: 10_000,
        afterMessages: [{ role: "user", content: "hi" }],
      }),
    ).toBe(false);
    // Not smaller → do not apply.
    expect(
      shouldApplyAutoCompact({
        summarized: true,
        summaryBody: "x".repeat(250),
        beforeTokens: 50_000,
        afterTokens: 60_000,
        afterMessages: [{ role: "user", content: "hi" }],
      }),
    ).toBe(false);
    // Meaningful shrink with real memory — apply even if not under a magic N.
    expect(
      shouldApplyAutoCompact({
        summarized: true,
        summaryBody: "x".repeat(250),
        beforeTokens: 50_000,
        afterTokens: 30_000,
        afterMessages: [{ role: "user", content: "hi" }],
      }),
    ).toBe(true);
  });
});
