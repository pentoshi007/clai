import { describe, expect, it } from "vitest";
import type { SuccessfulRequestSnapshot } from "../../src/types.js";
import { selectCompactionReplaySnapshot } from "../../src/agent/turn/compaction-replay-selection.js";

const snapshot: SuccessfulRequestSnapshot = {
  provider: "nvidia",
  model: "test-model",
  messages: [
    { role: "system", content: "stable constitution" },
    { role: "user", content: "first user turn" },
    { role: "assistant", content: "first answer" },
  ],
  thinking: { enabled: true, effort: "high" },
  tools: [
    {
      name: "fs.read",
      description: "read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    },
  ],
  toolChoice: "auto",
  parallelToolCalls: true,
};

const select = (
  candidate: SuccessfulRequestSnapshot | undefined,
  contextLimitTokens: number | undefined,
  history = snapshot.messages,
) =>
  selectCompactionReplaySnapshot({
    snapshot: candidate,
    history,
    provider: "nvidia",
    model: "test-model",
    contextLimitTokens,
    durableEnvelope: "canonical durable state",
  });

describe("compaction replay selection", () => {
  it("returns the identical snapshot only when its replay fits", () => {
    expect(select(snapshot, 1_000_000)).toBe(snapshot);
    expect(select(snapshot, 8)).toBeUndefined();
  });

  it("rejects absent and non-prefix snapshots", () => {
    expect(select(undefined, 1_000_000)).toBeUndefined();
    expect(
      select(snapshot, 1_000_000, [
        { role: "system", content: "different constitution" },
        ...snapshot.messages.slice(1),
      ]),
    ).toBeUndefined();
  });

  it("uses the model context window when no explicit limit is supplied", () => {
    expect(select(snapshot, undefined)).toBe(snapshot);
  });
});
