import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { getToolDefinitions } from "../../src/tools/definitions.js";
import { profileTokenContext } from "../../scripts/profile-token-context.js";
import { latestKeyedBlock, upsertKeyed } from "../../src/agent/injected-blocks.js";
import type { ChatMessage } from "../../src/types.js";

it("measures existing no-change suppression and append-only authority without inventing incremental savings", () => {
  const profile = profileTokenContext(100);
  expect(profile.repeated).toEqual({ addedMessages: 0, addedBytes: 0 });
  expect(profile.transitions).toEqual({ appendedMessages: 3, sentHistoryPreserved: true });
  expect(profile.incrementalStartupTokenSavings).toBe(0);
  expect(profile.incrementalTaskTokenSavings).toBe(0);
  expect(profile.sectionFiltering.retained).toEqual(["MCP TOOL CONTEXT", "ORCHESTRATION: OFF", "Current task: verify behavior"]);
  expect(profile.toolCount).toBe(45);
  expect(profile.toolsSha256).toBe("5ae8343fac23cfff9d8beb8c65f2c7e1c45c80a46ce8bfe04d4b0c805512eb77");
  expect(createHash("sha256").update(JSON.stringify(getToolDefinitions())).digest("hex")).toBe("02631147c616726c7fb421b355e359a09828eb56190036e282073db641b3c6c7");
  expect(() => profileTokenContext(0)).toThrow("Samples");
});

it("does not suppress a re-added authority merely because identical bytes occurred before a clear", () => {
  const messages: ChatMessage[] = [];
  const original = "SCOPE\nOnly the synthetic target";
  upsertKeyed(messages, "SCOPE", original);
  upsertKeyed(messages, "SCOPE", undefined);
  expect(messages.some((message) => message.content === original)).toBe(true);
  expect(latestKeyedBlock(messages, "SCOPE")).toBeUndefined();
  upsertKeyed(messages, "SCOPE", original);
  expect(messages).toHaveLength(3);
  expect(latestKeyedBlock(messages, "SCOPE")).toBe(original);
});
