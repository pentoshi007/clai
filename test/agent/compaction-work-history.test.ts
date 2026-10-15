import { describe, expect, it, vi } from "vitest";
import { compactMessages, compactMessagesWithSummary, isCompactionMemoryMessage, shouldApplyAutoCompact } from "../../src/agent/context-manager.js";
import { buildCompactionUserPrompt } from "../../src/agent/compaction-summary.js";
import { acceptPlanImplementCompaction } from "../../src/agent/plan-implement-compact.js";
import type { ChatMessage } from "../../src/types.js";
import { collectWorkHistory, compactionWorkHistoryAnchors, renderWorkHistory, withoutWorkHistory, WORK_HISTORY_INPUT_CHAR_BUDGET } from "../../src/agent/context/compaction-work-history.js";
import { renderUserInstructions, USER_INSTRUCTION_UPDATES_HEADING } from "../../src/agent/context/compaction-user-instructions.js";
import { withoutRecentUserPrompts } from "../../src/agent/context/compaction-recent-history.js";

const SUMMARY = "ORIENTATION: The latest request is in progress.\n\n## Current state\n- The latest module is being inspected.\n\n## Remaining work\n- Complete the latest request and verify it.";

function history(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "Stable normal system prefix" }];
  for (let i = 1; i <= 8; i += 1) messages.push(
    { role: "user", content: `Implement unrelated workstream ${i} in src/module-${i}.ts` },
    { role: "assistant", content: `Workstream ${i}: changed src/module-${i}.ts; regression ${i} passed. No commit was made.` },
  );
  return messages;
}

function memory(messages: ChatMessage[]) { return messages.find(isCompactionMemoryMessage)!; }

describe("all-workstream compaction continuity", () => {
  it.each([false, true])("retains earlier unrelated work even when the model only summarizes the latest topic (active=%s)", async (active) => {
    const messages = history();
    if (active) messages.push({ role: "user", content: "Now diagnose the pending module." });
    const summarize = vi.fn().mockResolvedValue(SUMMARY);
    const result = await compactMessagesWithSummary(messages, summarize, { budgetTokens: 0, singleAdmission: true, forceDirectSinglePass: true });
    expect(summarize).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 8; i += 1) {
      expect(memory(result.messages).content).toContain(`regression ${i} passed`);
      expect(memory(result.messages).content).toContain(`src/module-${i}.ts`);
    }
    expect(memory(result.messages).content).toContain("not new requests");
    expect(memory(result.messages).content).toContain(SUMMARY);
    expect(result.messages[0]).toBe(messages[0]);
    if (active) expect(result.messages).toContain(messages.at(-1));
  });

  it("preserves all work after six compactions and JSON persistence without duplicating live turns", async () => {
    let messages = history();
    for (let round = 0; round < 6; round += 1) {
      messages.push({ role: "user", content: `Pending follow-up ${round}` });
      const result = await compactMessagesWithSummary(messages, async () => SUMMARY, { budgetTokens: 0, singleAdmission: true, forceDirectSinglePass: true });
      messages = JSON.parse(JSON.stringify(result.messages));
      for (let i = 1; i <= 8; i += 1) expect(memory(messages).content).toContain(`regression ${i} passed`);
      expect(memory(messages).content.match(/Workstream 1: changed/g)).toHaveLength(1);
      messages.push({ role: "assistant", content: `Follow-up ${round}: checks were performed; further review is still pending.` });
    }
    expect(memory(messages).content).toContain("Follow-up 4: checks were performed");
  });

  it("also retains work through repeated mechanical fallback compaction", () => {
    let messages = history();
    for (let round = 0; round < 4; round += 1) {
      messages = compactMessages(messages, { budgetTokens: 0 });
      expect(memory(messages).content).toContain("regression 1 passed");
      messages.push({ role: "user", content: `Question ${round}` }, { role: "assistant", content: `Answer ${round}.` });
    }
  });

  it("preserves tool evidence without inventing completion and redacts credentials", async () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "Stable normal prefix" },
      { role: "user", content: "Check login using password: StagingPassword123!" },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "shell.exec", args: {} }] },
      { role: "tool", toolCallId: "t1", name: "shell.exec", content: "CHECK_RESULT: 3 passed, 1 failed.", ok: false },
      { role: "user", content: "Unrelated latest task" },
    ];
    const result = await compactMessagesWithSummary(messages, async () => SUMMARY, { singleAdmission: true, forceDirectSinglePass: true });
    expect(memory(result.messages).content).toContain("CHECK_RESULT: 3 passed, 1 failed");
    expect(memory(result.messages).content).toContain("No final response recorded");
    expect(JSON.stringify(memory(result.messages))).not.toContain("StagingPassword123!");
  });

  it("keeps the normal system prefix even for serialized visual compaction", async () => {
    const messages = history();
    let source: readonly ChatMessage[] | undefined;
    await compactMessagesWithSummary(messages, async (_prompt, stage) => { source = stage?.sourceMessages; return SUMMARY; }, { budgetTokens: 0 }, "Visual history of the latest task only.");
    expect(source?.[0]).toBe(messages[0]);
  });

  it("requires chronological coverage while emphasizing unfinished work without dropping completed topics", () => {
    const prompt = buildCompactionUserPrompt({ messageTranscript: "history" });
    expect(prompt).toContain("every user workstream");
    expect(prompt).not.toContain("Omit routine completed history");
  });

  it("retains a hundred topics across a bounded source-prefix fallback and subsequent compaction", async () => {
    const messages: ChatMessage[] = [{ role: "system", content: "Stable normal prefix" }];
    for (let i = 1; i <= 100; i += 1) messages.push(
      { role: "user", content: `Task-${i}` },
      { role: "assistant", content: `Outcome-${i}: verified tests. ${"nonessential log ".repeat(250)}` },
    );
    const before = structuredClone(messages);
    const summarize = vi.fn().mockResolvedValue(SUMMARY);
    const first = await compactMessagesWithSummary(messages, summarize, { budgetTokens: 0, singleAdmission: true, forcePrefixSlice: true, singlePassInputBudgetTokens: 6000 });
    expect(first.strategy).toBe("emergency_prefix_slice");
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(messages).toEqual(before);
    const second = await compactMessagesWithSummary(first.messages, summarize, { budgetTokens: 0, singleAdmission: true, forceDirectSinglePass: true });
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(memory(second.messages).compaction?.workHistory).toHaveLength(100);
    for (let i = 1; i <= 100; i += 1) expect(memory(second.messages).content).toContain(`Outcome-${i}:`);
    expect(second.afterTokens).toBeLessThan(6000);
    const ledger = collectWorkHistory(second.messages);
    expect(compactionWorkHistoryAnchors(ledger).length).toBeLessThanOrEqual(WORK_HISTORY_INPUT_CHAR_BUDGET);
    expect(renderWorkHistory(ledger).length).toBeLessThan(12_500);
  });

  it("keeps repeated identical requests as separate workstreams and ignores internal prompts", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "Check it again" }, { role: "assistant", content: "First attempt failed." },
      { role: "user", content: "Internal repair", internal: true },
      { role: "user", content: "Check it again" }, { role: "assistant", content: "Second attempt passed." },
    ];
    const ledger = collectWorkHistory(messages);
    expect(ledger).toHaveLength(2);
    expect(ledger.map((entry) => entry.outcome)).toEqual(["First attempt failed.", "Second attempt passed."]);
  });

  it("does not resurrect retired instructions from archived requests", async () => {
    const rule = { id: "U1", scope: "session" as const, text: "Keep the old approval requirement." };
    const initial = await compactMessagesWithSummary([
      { role: "system", content: "Normal prefix" },
      { role: "user", content: `Inspect the parser. ${rule.text}` },
      { role: "assistant", content: "Parser checks passed." },
    ], async () => `${renderUserInstructions([rule])}\n\n${SUMMARY}`, { forceDirectSinglePass: true });
    const quote = "Remove the old approval requirement.";
    const next = await compactMessagesWithSummary([...initial.messages, { role: "user", content: quote }, { role: "assistant", content: "Revocation recorded." }], async () => `${USER_INSTRUCTION_UPDATES_HEADING}\n- [U1] revoked; user: ${JSON.stringify(quote)}\n\n${SUMMARY}`, { forceDirectSinglePass: true });
    expect(memory(next.messages).compaction?.userInstructions).toEqual([]);
    expect(withoutRecentUserPrompts(memory(next.messages).content)).not.toContain(rule.text);
    expect(JSON.stringify(memory(next.messages).compaction?.workHistory)).not.toContain(rule.text);
    expect(memory(next.messages).content).toContain("historical instruction U1 retired or superseded");
    expect(memory(next.messages).content).toContain("Parser checks passed.");
  });

  it.each(["", "TOOL: Tool result\n[tools: fs.read]\nbytes = 12", "## Work completed\n- we did the"])("fails closed after one unusable summary instead of masking it with history (%s)", async (bad) => {
    const messages = history();
    const before = structuredClone(messages);
    const summarize = vi.fn().mockResolvedValue(bad);
    await expect(compactMessagesWithSummary(messages, summarize, { singleAdmission: true, forceDirectSinglePass: true })).rejects.toThrow(/compaction failed/);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(messages).toEqual(before);
  });

  it.each([
    "Session memory from compacted earlier turns:",
    "Earlier turns in this session, summarized to fit the context budget.",
    "PLAN MODE HANDOFF: current gates are re-injected.",
    "Session memory from PLAN MODE research that was used to build the comprehensive detailed plan and tasks you are seeing now (handoff to agent implement):",
  ])("migrates earlier memory without repeating its wrapper (%s)", (prefix) => {
    const ledger = collectWorkHistory([{ role: "system", content: `${prefix}\n\nOlder parser work was checked.` }]);
    expect(ledger).toEqual([{ request: "Earlier compacted session work", outcome: "Older parser work was checked." }]);
  });

  it("removes all ledger sections from quality assessment without removing later main memory", () => {
    const summary = "ok\n\n## Session work history (preserved)\nold result\n\n## Current state\nActual state.\n\n## SESSION WORK HISTORY (PRESERVED)\nother result";
    expect(withoutWorkHistory(summary)).toBe("ok\n\n## Current state\nActual state.");
    expect(withoutWorkHistory("The ledger is named ## Session work history (preserved).")).toContain("ledger is named");
  });

  it("does not let an appended work ledger make an inadequate summary pass quality gates", () => {
    const summaryBody = `ok\n\n## Session work history (preserved)\n${"earlier work was checked. ".repeat(100)}`;
    const input = { summarized: true, summaryBody, beforeTokens: 40_000, afterTokens: 1000, afterMessages: [{ role: "system" as const, content: summaryBody }] };
    expect(shouldApplyAutoCompact(input)).toBe(false);
    expect(acceptPlanImplementCompaction(input).accept).toBe(false);
  });
});
