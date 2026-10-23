import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import type { ChatMessage, NativeToolCall } from "../../src/types.js";
import { compactMessages, compactMessagesWithSummary, isCompactionMemoryMessage } from "../../src/agent/context-manager.js";
import { TOOL_DEFINITIONS } from "../../src/tools/definitions.js";

const name = "clai-superman-skill";
const file = join(tmpdir(), "clai-skill-recovery", name, "SKILL.md");
const reference = join(tmpdir(), "clai-skill-recovery", name, "references", "web-api.md");
const summary = "## Active goal\nContinue the API assessment.\n\n## Context gathered\nA tenant authorization boundary is under review.\n\n## Current state and next steps\nValidate the pending hypothesis using controlled tenants.";
const skill = { name, file, resources: ["references/web-api.md"] };

function history(native: boolean): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: "Stable system prefix" }];
  const calls: NativeToolCall[] = [
    { id: "load", name: "skill.load", args: { name } },
    { id: "read", name: "fs.read", args: { path: reference } },
  ];
  const outputs = [
    `skill: ${name} [bundled/clai]\nfile: ${file}\n\n---\n\nFull core instructions that must not be duplicated in recovery memory.`,
    "Full domain reference that must not be duplicated in recovery memory.",
  ];
  for (const [index, call] of calls.entries()) {
    messages.push(native
      ? { role: "assistant", content: "", toolCalls: [call] }
      : { role: "assistant", content: `\`\`\`tool\n${JSON.stringify({ name: call.name, args: call.args })}\n\`\`\`` });
    messages.push({
      role: "tool", content: `Tool ${call.name} result (exit=0, ok=true):\n${outputs[index]}`,
      ...(native ? { toolCallId: call.id, name: call.name, ok: true } : {}),
    });
  }
  messages.push({ role: "assistant", content: "The API boundary is mapped." }, { role: "user", content: "Continue the assessment." });
  return messages;
}

it.each([true, false])("recovers loaded skills and references across repeated compactions (native=%s)", async native => {
  let messages = history(native);
  for (let round = 0; round < 3; round += 1) {
    const before = structuredClone(messages);
    const summarize = vi.fn(async () => summary);
    const result = await compactMessagesWithSummary(messages, summarize, { budgetTokens: 0 });
    const memory = result.messages.find(isCompactionMemoryMessage)!;
    expect(result.summarized).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(memory.compaction).toMatchObject({ skills: [skill] });
    expect(memory.content).toContain(name);
    expect(memory.content).toContain(file);
    expect(memory.content).toContain("references/web-api.md");
    expect(memory.content).toContain("skill.load");
    expect(memory.content).toContain("fs.read");
    expect(memory.content.match(/## Skill recovery after compaction/g)).toHaveLength(1);
    expect(memory.content).not.toContain("Full core instructions");
    expect(memory.content).not.toContain("Full domain reference");
    expect(result.messages[0]).toEqual(messages[0]);
    expect(messages).toEqual(before);
    messages = JSON.parse(JSON.stringify([...result.messages, { role: "user", content: `Continue round ${round + 1}.` }]));
  }
});

it("preserves the same skill recovery in mechanical compaction", () => {
  const messages = history(true);
  const result = compactMessages(messages, { budgetTokens: 0 });
  const memory = result.find(isCompactionMemoryMessage)!;
  expect(memory.compaction).toMatchObject({ skills: [skill] });
  expect(memory.content).toContain("## Skill recovery after compaction");
  expect(memory.content).toContain("references/web-api.md");
});

it("allows reloading lost skill instructions instead of banning repeat loads for a session", () => {
  const load = TOOL_DEFINITIONS.find(tool => tool.name === "skill.load")!;
  expect(load.description).not.toContain("never load the same skill twice in a session");
  expect(load.description).toMatch(/compaction/);
});
