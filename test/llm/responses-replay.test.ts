import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../src/types.js";
import { createReasoningArtifact, createReasoningArtifactProvenance } from "../../src/llm/reasoning-artifacts.js";
import { restoreResponsesReplay, responsesReplayItems } from "../../src/llm/responses-replay.js";

const model = "gpt-6.1-sol";
const reasoning = { type: "reasoning", id: "rs_original", encrypted_content: "gAAAA_gsk_ciphertext" };
const visible = { type: "message", id: "msg_original", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Checking" }] };
const call = { type: "function_call", id: "fc_original", call_id: "call_1", name: "fs_read", arguments: '{ "path": "example.ts" }' };

function damagedMessage(sourceModel = model): ChatMessage {
  return {
    role: "assistant", content: "Checking", toolCalls: [{ id: "call_1", name: "fs.read", args: { path: "example.ts" } }],
    reasoningArtifacts: [createReasoningArtifact({
      kind: "encrypted", raw: reasoning,
      provenance: createReasoningArtifactProvenance({ provider: "codex", model: sourceModel, dialect: "openai-compatible" }),
      replay: { scope: "all-history", persistence: "all-turns" },
    })],
    responsesReplay: { provider: "codex", model, items: [{ ...reasoning, encrypted_content: "gAAAA_gsk_••••••" }, visible, call] },
  };
}

describe("ChatGPT replay repair", () => {
  it("repairs opaque bytes without changing item order, phases, identities or raw tool arguments", () => {
    const message = damagedMessage();
    expect(responsesReplayItems(message, "codex", model)).toEqual([reasoning, visible, call]);
    expect(message.responsesReplay!.items[0]!.encrypted_content).toBe("gAAAA_gsk_••••••");
  });

  it.each([undefined, "different-model"])("omits damaged reasoning when a matching intact copy is unavailable: %s", (sourceModel) => {
    const message = damagedMessage(sourceModel);
    if (sourceModel === undefined) delete message.reasoningArtifacts;
    expect(responsesReplayItems(message, "codex", model)).toEqual([visible, call]);
  });

  it("does not recover from a different reasoning item", () => {
    const message = damagedMessage();
    message.reasoningArtifacts = message.reasoningArtifacts!.map((artifact) => ({ ...artifact, raw: { ...reasoning, id: "rs_unrelated" } }));
    expect(responsesReplayItems(message, "codex", model)).toEqual([visible, call]);
  });

  it("keeps undamaged replay byte-identical and avoids rebuilding unchanged messages", () => {
    const message = damagedMessage();
    message.responsesReplay = { provider: "codex", model, items: [reasoning, visible, call] };
    expect(restoreResponsesReplay(message)).toBe(message);
    expect(responsesReplayItems(message, "codex", model)).toBe(message.responsesReplay.items);
  });

  it("still invalidates replay when visible content, tools or the route change", () => {
    const message = damagedMessage();
    expect(responsesReplayItems({ ...message, content: "Compacted" }, "codex", model)).toBeUndefined();
    expect(responsesReplayItems({ ...message, toolCalls: [] }, "codex", model)).toBeUndefined();
    expect(responsesReplayItems(message, "codex", "other-model")).toBeUndefined();
    expect(responsesReplayItems(message, "openai", model)).toBeUndefined();
  });
});
