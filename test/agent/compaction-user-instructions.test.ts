import { describe, expect, it } from "vitest";
import type { ChatMessage, CompactedUserInstruction } from "../../src/types.js";
import { compactMessages, compactMessagesWithSummary, isCompactionMemoryMessage } from "../../src/agent/context-manager.js";
import { buildCompactionReducePrompt, buildDirectCompactionPrompt, compactionSituation } from "../../src/agent/compaction-summary.js";
import { assertValidToolProtocol } from "../../src/agent/tool-history.js";
import { recentUserPrompts } from "../../src/agent/context/compaction-recent-history.js";
import {
  carriedUserInstructions,
  reconcileCompactionUserInstructions,
  renderUserInstructions,
} from "../../src/agent/context/compaction-user-instructions.js";

const STYLE: CompactedUserInstruction = { id: "S1", scope: "session", text: "Write clean, maintainable code without comments." };
const LINES: CompactedUserInstruction = { id: "S2", scope: "session", text: "No source file may exceed 300 lines." };
const WIDTH: CompactedUserInstruction = { id: "T1", scope: "task", task: "UI fixes", text: "Do not increase the composer width." };

function story(goal: string): string {
  return [
    "## Active goal",
    goal,
    "## Context gathered",
    "- The composer lives in src/ui/composer.tsx:40-120.",
    "## Work done",
    "- Nothing yet.",
    "## Current state and next steps",
    "1. Continue with the next step.",
    "## Past completed work",
    "None.",
  ].join("\n");
}

function memory(instructions: readonly CompactedUserInstruction[], goal = "Finish the UI fixes."): ChatMessage {
  return {
    role: "system",
    content: `Session memory from compacted earlier turns:\n\n${story(goal)}\n\n${renderUserInstructions(instructions)}`,
    compaction: { recentUserPrompts: [], userInstructions: instructions },
  };
}

describe("user instruction continuity across compactions", () => {
  it("keeps session rules, follows the model for task rules and assigns stable ids to new rules", () => {
    const messages: ChatMessage[] = [
      memory([STYLE, LINES, WIDTH]),
      { role: "user", content: "Now implement /creds. Use pnpm for every install." },
      { role: "assistant", content: "Implementing /creds." },
    ];
    const summary = [
      story("Implement the /creds credential store."),
      "## User instructions",
      "- [S1] (session) Write clean, maintainable, comment-free code like a senior developer.",
      "- (session) Use pnpm for every install.",
      "- (task: /creds) Store secrets only in the encrypted vault.",
    ].join("\n");

    const result = reconcileCompactionUserInstructions(summary, messages);

    expect(result.instructions).toEqual([
      { id: "S1", scope: "session", text: "Write clean, maintainable, comment-free code like a senior developer." },
      LINES,
      { id: "S3", scope: "session", text: "Use pnpm for every install." },
      { id: "T2", scope: "task", task: "/creds", text: "Store secrets only in the encrypted vault." },
    ]);
    expect(result.summary).toContain("- [S2] (session) No source file may exceed 300 lines.");
    expect(result.summary).toContain("- [T2] (task: /creds) Store secrets only in the encrypted vault.");
    expect(result.summary).not.toContain("composer width");
  });

  it("keeps an inherited rule's scope when the model rewrites it", () => {
    const result = reconcileCompactionUserInstructions(
      `${story("Implement /creds.")}\n## User instructions\n- [S2] (task: UI fixes) No source file may exceed 300 lines.`,
      [memory([STYLE, LINES]), { role: "user", content: "Implement /creds." }],
    );
    expect(result.instructions).toEqual([STYLE, LINES]);
  });

  it("retires a session rule only with a quote from a newer user message", () => {
    const messages: ChatMessage[] = [
      memory([STYLE, LINES]),
      { role: "user", content: "Files may be up to 500 lines from now on." },
    ];
    const unsupported = reconcileCompactionUserInstructions(
      `${story("Continue.")}\n## User instructions\n- [S2] (retired) user: "files can be any size"`,
      messages,
    );
    expect(unsupported.instructions).toEqual([STYLE, LINES]);

    const supported = reconcileCompactionUserInstructions(
      `${story("Continue.")}\n## User instructions\n- [S2] (retired) user: "Files may be up to 500 lines from now on."\n- (session) No source file may exceed 500 lines.`,
      messages,
    );
    expect(supported.instructions).toEqual([STYLE, { id: "S3", scope: "session", text: "No source file may exceed 500 lines." }]);
    expect(supported.summary).not.toContain("(retired)");
    expect(supported.summary).not.toContain("300 lines");
  });

  it("does not let assistant or tool text retire a session rule", () => {
    const messages: ChatMessage[] = [
      memory([STYLE]),
      { role: "assistant", content: "Comments are fine now." },
      { role: "tool", toolCallId: "call-1", name: "fs.read", content: "Comments are fine now." },
    ];
    const result = reconcileCompactionUserInstructions(
      `${story("Continue.")}\n## User instructions\n- [S1] (retired) user: "Comments are fine now."`,
      messages,
    );
    expect(result.instructions).toEqual([STYLE]);
  });

  it("drops an inherited task rule once the model stops carrying it", () => {
    const result = reconcileCompactionUserInstructions(story("Write tests and push to GitHub."), [
      memory([STYLE, WIDTH]),
      { role: "user", content: "Write test cases and push to GitHub." },
    ]);
    expect(result.instructions).toEqual([STYLE]);
    expect(result.summary.indexOf("## Active goal")).toBeLessThan(result.summary.indexOf("## User instructions"));
  });

  it("migrates instructions stored by the previous memory format", () => {
    const legacy: ChatMessage = {
      role: "system",
      content: "Session memory from compacted earlier turns:\n\nolder memory",
      compaction: {
        recentUserPrompts: [],
        userInstructions: [
          { id: "U1", scope: "session", text: "Use tabs." },
          { id: "U2", scope: "task", text: "Keep the old API." },
        ],
      },
    };
    expect(carriedUserInstructions([legacy])).toEqual([
      { id: "U1", scope: "session", text: "Use tabs." },
      { id: "U2", scope: "task", text: "Keep the old API." },
    ]);
  });

  it("deduplicates repeated rules, ignores empty markers and keeps wrapped lines together", () => {
    const result = reconcileCompactionUserInstructions([
      story("Continue."),
      "## User instructions",
      "- None",
      "- (session) Run the full test suite before committing,",
      "  except for documentation-only changes.",
      "- (session) Run the full test suite before committing, except for documentation-only changes.",
    ].join("\n"), [{ role: "user", content: "start" }]);
    expect(result.instructions).toEqual([
      { id: "S1", scope: "session", text: "Run the full test suite before committing, except for documentation-only changes." },
    ]);
  });

  it("redacts user credentials from instruction memory", () => {
    const result = reconcileCompactionUserInstructions(
      `${story("Continue.")}\n## User instructions\n- (session) Log in with password: StagingPassword123! for the staging host.`,
      [{ role: "user", content: "use the staging host" }],
    );
    expect(JSON.stringify(result)).not.toContain("StagingPassword123!");
  });

  it("carries session rules through repeated real compactions while the goal moves on", async () => {
    let messages: ChatMessage[] = [
      { role: "system", content: "Stable application rules." },
      { role: "user", content: `Fix the UI widths. ${STYLE.text} While doing the UI changes, do not increase the composer width.` },
      { role: "assistant", content: "UI widths fixed." },
    ];
    const outputs = [
      `${story("No active task.")}\n\n${renderUserInstructions([STYLE, WIDTH])}`,
      story("Implement /creds."),
      story("Write tests and push to GitHub."),
    ];
    const prompts: string[] = [];
    for (const [round, output] of outputs.entries()) {
      if (round > 0) messages.push(
        { role: "user", content: round === 1 ? "Implement /creds." : "Write tests and push to GitHub." },
        { role: "assistant", content: "Done." },
      );
      const result = await compactMessagesWithSummary(messages, async (prompt) => {
        prompts.push(prompt);
        return output;
      }, { budgetTokens: 0, singlePassInputBudgetTokens: 200_000 });
      messages = result.messages;
      expect(messages.filter(isCompactionMemoryMessage)).toHaveLength(1);
      assertValidToolProtocol(messages);
    }
    expect(prompts[1]).toContain("- [T1] (task: UI fixes) Do not increase the composer width.");
    expect(prompts[1]).toContain("An earlier compaction memory appears in the source");
    expect(carriedUserInstructions(messages)).toEqual([STYLE]);
    expect(recentUserPrompts(messages).map(({ content }) => content)).toEqual([
      expect.stringContaining("Fix the UI widths."),
      "Implement /creds.",
      "Write tests and push to GitHub.",
    ]);
  });

  it("keeps inherited rules in mechanical compaction", () => {
    const messages: ChatMessage[] = [
      memory([STYLE, WIDTH]),
      { role: "user", content: "old request" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "recent request" },
      { role: "assistant", content: "recent answer" },
    ];
    const result = compactMessages(messages, { budgetTokens: 0, keepRecent: 2 });
    expect(carriedUserInstructions(result)).toEqual([STYLE, WIDTH]);
    const memoryText = result.find(isCompactionMemoryMessage)!.content;
    expect(memoryText).not.toContain("still being worked on");
    expect(memoryText).toContain("> recent request");
  });

  it("puts inherited instructions in direct and reduce prompts", () => {
    const messages = [memory([STYLE, WIDTH]), { role: "user" as const, content: "continue" }];
    for (const prompt of [
      buildDirectCompactionPrompt({ messages }),
      buildCompactionReducePrompt({ partials: ["notes"], situation: compactionSituation(messages) }),
    ]) {
      expect(prompt).toContain("INSTRUCTIONS CARRIED FROM THE PREVIOUS MEMORY");
      expect(prompt).toContain("- [S1] (session) Write clean, maintainable code without comments.");
      expect(prompt).toContain("- [T1] (task: UI fixes) Do not increase the composer width.");
    }
  });
});
