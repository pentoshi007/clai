import { describe, expect, it } from "vitest";
import {
  buildCompactionChunkPrompt,
  buildCompactionReducePrompt,
  buildCompactionUserPrompt,
  buildDirectCompactionPrompt,
} from "../../src/agent/compaction-summary.js";

function expectSubagentIdentity(prompt: string): void {
  expect(prompt).toContain("Delegated workers are subagents");
  expect(prompt).toContain("id and attempt");
  expect(prompt).toContain("whether its result was read");
  expect(prompt).toContain("recoverable by id and attempt");
  expect(prompt).toContain("Keep background jobs and Responder tasks separate from subagents");
  expect(prompt).not.toMatch(/\bsubagent\.(?:read|list)\b/);
}

function expectRegionSubagents(prompt: string): void {
  expect(prompt).toContain("tool, web and subagent findings");
  expect(prompt).not.toMatch(/\bsubagent\.(?:read|list)\b/);
}

describe("explicit subagent identity during compaction", () => {
  it.each(["default", "plan-implement"] as const)(
    "preserves subagents in every %s compaction strategy",
    (purpose) => {
      const durableState = "Subagents: [child-1] Inspect source (completed, attempt 2, result read)";
      expectSubagentIdentity(buildCompactionUserPrompt({
        purpose,
        source: { kind: "transcript", text: "Subagent child-1 verified the source." },
        durableState,
      }));
      expectSubagentIdentity(buildDirectCompactionPrompt({ purpose, durableState, messages: [] }));
      expectRegionSubagents(buildCompactionChunkPrompt({
        purpose,
        chunk: "Subagent child-1 verified the source.",
        index: 0,
        total: 2,
      }));
      expectSubagentIdentity(buildCompactionReducePrompt({
        purpose,
        partials: ["Subagents: child-1 completed; source verified."],
        durableState,
      }));
    },
  );
});
