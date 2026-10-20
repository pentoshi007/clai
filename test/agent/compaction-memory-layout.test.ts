import { describe, expect, it } from "vitest";
import { canonicalMemoryLayout } from "../../src/agent/compaction/memory-sections.js";

describe("canonical memory layout", () => {
  it("orders sections, merges duplicates and keeps unknown sections after the known ones", () => {
    const layout = canonicalMemoryLayout([
      "## Work done",
      "- Edited src/a.ts:10.",
      "## Notes",
      "- extra",
      "## active goal",
      "Ship /creds.",
      "## Work done",
      "- Ran npm test: 12 passed.",
    ].join("\n"));
    expect(layout).toBe([
      "## Active goal\nShip /creds.",
      "## Work done\n- Edited src/a.ts:10.\n- Ran npm test: 12 passed.",
      "## Notes\n- extra",
    ].join("\n\n"));
  });

  it("omits an empty issues section and a model-written prompt section", () => {
    for (const body of ["None", "- None.", "No genuine issues.", ""]) {
      const layout = canonicalMemoryLayout(`## Active goal\nGoal.\n## Issues and risks\n${body}\n## Last 3 user prompts (latest first)\n> hi`);
      expect(layout).toBe("## Active goal\nGoal.");
    }
    expect(canonicalMemoryLayout("## Active goal\nGoal.\n## Issues and risks\n- test/a.test.ts fails.")).toContain("## Issues and risks\n- test/a.test.ts fails.");
  });

  it("does not split on headings inside fenced code", () => {
    const layout = canonicalMemoryLayout("## Context gathered\n```md\n## Active goal\n```\n## Active goal\nGoal.");
    expect(layout).toBe("## Active goal\nGoal.\n\n## Context gathered\n```md\n## Active goal\n```");
  });
});
