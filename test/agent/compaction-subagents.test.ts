import { describe, expect, it } from "vitest";
import {
  buildCompactionChunkPrompt,
  buildCompactionReducePrompt,
  buildCompactionUserPrompt,
  buildDirectCompactionPrompt,
  COMPACTION_SYSTEM_PROMPT,
} from "../../src/agent/compaction-summary.js";

function expectSubagentIdentity(prompt: string): void {
  expect(prompt).toContain('"subagents"');
  expect(prompt).toContain("## Subagents");
  expect(prompt).toContain("id");
  expect(prompt).toContain("attempt");
  expect(prompt).toContain("title");
  expect(prompt).toContain("status");
  expect(prompt).toContain("result");
  expect(prompt).toContain("pending");
  expect(prompt).toContain("subagent.read");
  expect(prompt).toContain("subagent.list");
  expect(prompt).toContain("separately");
  expect(prompt).not.toContain("- Delegated work:");
}

describe("explicit subagent identity during compaction", () => {
  it("requires explicit identity in the shared summarizer system prompt", () => {
    expectSubagentIdentity(COMPACTION_SYSTEM_PROMPT);
  });

  it.each(["default", "plan-implement"] as const)(
    "preserves subagents in every %s compaction strategy",
    (purpose) => {
      const durableState = "Subagents: [child-1] Inspect source (completed, attempt 2, result read)";
      expectSubagentIdentity(buildCompactionUserPrompt({
        purpose,
        messageTranscript: "Subagent child-1 verified the source.",
        durableState,
      }));
      expectSubagentIdentity(buildDirectCompactionPrompt({ purpose, durableState }));
      expectSubagentIdentity(buildCompactionChunkPrompt({
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
