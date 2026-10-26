import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSubagentStore } from "../../src/store/subagents.js";
import { clearAllHistory, deleteSession, saveSession } from "../../src/store/history.js";
import type { SubagentRun } from "../../src/agent/subagents/types.js";

const record = (parentSessionId: string): SubagentRun => ({
  id: `child-${createHash("sha256").update(parentSessionId).digest("hex")}`, parentSessionId, attempt: 1, status: "completed",
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
  it("retains child transcripts when the generated parent ID contains sk-", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Number.parseInt("mvp5eksk", 36));
    try {
      const parent = await seed("subagent-parent-secret-like-id");
      expect(parent).toMatch(/^mvp5eksk-/);
      expect(createSubagentStore().load(parent)).toHaveLength(1);
      expect((await deleteSession(parent)).deleted).toBe(true);
      expect(createSubagentStore().load(parent)).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

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
