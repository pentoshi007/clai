import { describe, expect, it } from "vitest";
import { createSubagentStore } from "../../src/store/subagents.js";
import { clearAllHistory, deleteSession, saveSession } from "../../src/store/history.js";
import type { SubagentRun } from "../../src/agent/subagents/types.js";

const record = (parentSessionId: string): SubagentRun => ({
  id: `child-${parentSessionId}`, parentSessionId, attempt: 1, status: "completed",
  title: "Inspect package", prompt: "Read package metadata", cwd: process.cwd(),
  provider: "openai", model: "gpt-4.1", createdAt: 1, updatedAt: 2,
  events: [{ sequence: 1, kind: "assistant", text: "Found package metadata", timestamp: 2 }],
  report: "Package metadata was inspected.",
});

async function seed(name: string): Promise<string> {
  const saved = await saveSession([{ role: "user", content: name }], name);
  createSubagentStore().save(record(saved.id));
  return saved.id;
}

describe("subagent history lifecycle", () => {
  it("deletes only the selected parent's child transcripts", async () => {
    const one = await seed("subagent-parent-one");
    const two = await seed("subagent-parent-two");
    expect(createSubagentStore().load(one)).toHaveLength(1);
    expect((await deleteSession(one)).deleted).toBe(true);
    expect(createSubagentStore().load(one)).toEqual([]);
    expect(createSubagentStore().load(two)).toHaveLength(1);
  });

  it("clears child transcripts with all history", async () => {
    const one = await seed("subagent-parent-clear-one");
    const two = await seed("subagent-parent-clear-two");
    await clearAllHistory();
    expect(createSubagentStore().load(one)).toEqual([]);
    expect(createSubagentStore().load(two)).toEqual([]);
  });
});
