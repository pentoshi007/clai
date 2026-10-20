import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import { compactMessagesWithSummary, isCompactionMemoryMessage } from "../../src/agent/context-manager.js";
import { assertValidToolProtocol } from "../../src/agent/tool-history.js";

function memoryFor(goal: string, past: string): string {
  return [
    "## Past completed work",
    past,
    "## Current state and next steps",
    "1. Continue the active goal.",
    "## Active goal",
    goal,
    "## Context gathered",
    "- src/ui/composer.tsx:40 renders the composer.",
    "## Work done",
    "- Nothing yet.",
    "## Relevant files",
    "- `src/ui/composer.tsx:40-120` — Composer",
  ].join("\n");
}

function toolStep(id: string, path: string): ChatMessage[] {
  return [
    { role: "assistant", content: "", toolCalls: [{ id, name: "fs.read", args: { path } }] },
    { role: "tool", toolCallId: id, name: "fs.read", ok: true, content: `contents of ${path}` },
  ];
}

async function compact(messages: ChatMessage[], output: string): Promise<{ prompt: string; messages: ChatMessage[] }> {
  let prompt = "";
  const result = await compactMessagesWithSummary(messages, async (value) => {
    prompt = value;
    return output;
  }, { budgetTokens: 0, singleAdmission: true, preserveActiveTurn: true, singlePassInputBudgetTokens: 400_000 });
  assertValidToolProtocol(result.messages);
  return { prompt, messages: result.messages };
}

function memoryOf(messages: readonly ChatMessage[]): string {
  return messages.find(isCompactionMemoryMessage)!.content;
}

describe("compaction across a multi-task session", () => {
  it("orients each compaction to the latest task, follow-up and past work", async () => {
    let messages: ChatMessage[] = [
      { role: "system", content: "Stable system prompt" },
      { role: "user", content: "Fix the UI: shrink the sidebar width. Never add code comments." },
      ...toolStep("c1", "src/ui/sidebar.tsx"),
    ];

    const first = await compact(messages, memoryFor("Shrink the sidebar width.", "None."));
    expect(first.prompt).toContain("The agent was in the middle of the latest user request");
    expect(first.prompt).not.toContain("An earlier compaction memory appears");
    expect(first.messages.at(-3)?.content).toContain("Fix the UI");
    messages = [
      ...first.messages,
      { role: "assistant", content: "Sidebar width reduced and verified." },
      { role: "user", content: "Implement a /creds command that stores credentials." },
      ...toolStep("c2", "src/commands/catalog.ts"),
    ];

    const second = await compact(messages, memoryFor("Implement /creds.", "- UI fix: sidebar width reduced and verified."));
    expect(second.prompt).toContain("An earlier compaction memory appears in the source");
    expect(second.prompt).toMatch(/1\. "Implement a \/creds command[^"]*"\n2\. "Fix the UI/);
    messages = [
      ...second.messages,
      { role: "user", content: "Actually store them encrypted with AES-256-GCM instead of plaintext." },
      ...toolStep("c3", "src/store/credentials.ts"),
    ];

    const third = await compact(messages, memoryFor("Implement /creds with AES-256-GCM encryption.", "- UI fix: sidebar width reduced and verified."));
    expect(third.prompt).toMatch(/1\. "Actually store them encrypted[^"]*"\n2\. "Implement a \/creds/);
    expect(third.messages.some((message) => message.role === "user" && message.content.startsWith("Actually store them encrypted"))).toBe(true);
    expect(memoryOf(third.messages)).toContain("### 1. Latest prompt (still being worked on");
    messages = [
      ...third.messages,
      { role: "assistant", content: "/creds implemented with AES-256-GCM." },
      { role: "user", content: "Write test cases and push to GitHub." },
      ...toolStep("c4", "test/credentials.test.ts"),
    ];

    const fourth = await compact(messages, memoryFor("Write tests for /creds and push to GitHub.", "- UI fix done.\n- /creds implemented with AES-256-GCM."));
    const memory = memoryOf(fourth.messages);
    const order = ["## Active goal", "## Context gathered", "## Work done", "## Current state and next steps", "## Past completed work", "## Relevant files", "## Last 3 user prompts (latest first)"]
      .map((heading) => memory.indexOf(heading));
    expect(order.every((index) => index > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(memory).toMatch(/### 2\. Second latest prompt\n\n> Actually store them encrypted/);
    expect(memory).toMatch(/### 3\. Third latest prompt\n\n> Implement a \/creds command/);
    expect(fourth.messages.filter(isCompactionMemoryMessage)).toHaveLength(1);
  });
});
