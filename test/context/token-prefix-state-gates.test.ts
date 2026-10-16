import { expect, it } from "vitest";
import type { ChatMessage, ToolDefinition } from "../../src/types.js";
import { buildChatBody } from "../../src/llm/wire/chat-body.js";
import { fingerprintFinalRequest } from "../../src/llm/request-fingerprint.js";
import { upsertKeyed, latestKeyedBlock } from "../../src/agent/injected-blocks.js";
import { wireHistoryStable, wirePrefixStable, type EvaluationWire } from "../../scripts/token-evaluation-metrics.js";

const wire = (messages: ChatMessage[], tools: ToolDefinition[] = [{ name: "http.fetch", wireName: "http_fetch", description: "Raw evidence", parameters: { type: "object", properties: {} } }]): EvaluationWire => ({
  ordinal: 1, statusCode: 200, elapsedMs: 1,
  fingerprint: fingerprintFinalRequest({ provider: "nvidia", model: "synthetic" }, buildChatBody({ providerId: "nvidia", model: "synthetic", messages, tools, stream: false })) ?? null,
});
it.each(["ENVIRONMENT", "SCOPE", "PLAN", "SKILL", "PROJECT INSTRUCTIONS", "ORCHESTRATION", "MCP TOOL CONTEXT"])("D03/D04 append %s changes, clear/re-add and preserve all submitted wire history", (prefix) => {
  const messages: ChatMessage[] = [{ role: "system", content: "Immutable coding and security core" }, { role: "user", content: "Complete every criterion" }];
  const requests: EvaluationWire[] = [];
  for (const revision of ["one", "one", "two", undefined, undefined, "one"]) {
    const before = structuredClone(messages);
    upsertKeyed(messages, prefix, revision ? `${prefix}\n${revision}` : undefined);
    expect(messages.slice(0, before.length)).toEqual(before);
    requests.push(wire(messages));
  }
  expect(messages.filter((message) => message.content.startsWith(prefix))).toHaveLength(4);
  expect(latestKeyedBlock(messages, prefix)).toBe(`${prefix}\none`);
  expect(wirePrefixStable(requests)).toBe(true);
  expect(wireHistoryStable(requests)).toBe(true);
  const changed = structuredClone(messages);
  changed[1]!.content = "Earlier user criteria silently changed";
  expect(wireHistoryStable([requests.at(-1)!, wire(changed)])).toBe(false);
  expect(wirePrefixStable([requests.at(-1)!, wire(changed)])).toBe(true);
});
it("D13 rejects historical rewrites or removed results even when the static system/catalog stay identical", () => {
  const messages: ChatMessage[] = [{ role: "system", content: "Stable" }, { role: "user", content: "Inspect" }, { role: "assistant", content: "Observed evidence" }, { role: "user", content: "Continue" }];
  const first = wire(messages);
  expect(wireHistoryStable([first, wire([...messages, { role: "assistant", content: "Continued" }])])).toBe(true);
  expect(wireHistoryStable([first, wire(messages.slice(0, 2))])).toBe(false);
  expect(wireHistoryStable([first, { ...first, fingerprint: null }])).toBeNull();
  expect(wireHistoryStable([])).toBeNull();
});
