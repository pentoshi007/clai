import { describe, expect, it } from "vitest";

import { createToolResultRecorder } from "../../src/agent/turn/tool-result-recorder.js";
import type { ChatMessage } from "../../src/types.js";

const baseRecord = {
  id: "tool-1",
  call: { name: "fs.read", args: { path: "a.ts" } },
  result: { ok: true, output: "body", exitCode: 0 },
  contextOutput: "body",
  isPlanMode: false,
  planApproved: false,
  hasDraftPlan: false,
  productiveStep: 1,
  kindHint: "general" as const,
};

const setup = (useNativeToolHistory = false) => {
  const messages: ChatMessage[] = [];
  const deferredPostToolMessages: ChatMessage[] = [];
  const notices: Array<{ level: "info" | "warn"; text: string }> = [];
  const remindedAt = new Set<number>();
  const recorder = createToolResultRecorder({
    messages,
    useNativeToolHistory,
    deferredPostToolMessages,
    seenHashes: new Map(),
    remindedAt,
    writeNotice: (level, text) => notices.push({ level, text }),
  });
  return { messages, deferredPostToolMessages, notices, remindedAt, recorder };
};

describe("createToolResultRecorder", () => {
  it("records text-tool history with the existing result envelope", () => {
    const { messages, recorder } = setup();
    recorder.record(baseRecord);
    expect(messages).toEqual([
      {
        role: "tool",
        content: "Tool fs.read result (exit=0, ok=true):\nbody",
      },
    ]);
  });

  it("records native history with the provider tool-call id", () => {
    const { messages, recorder } = setup(true);
    recorder.record(baseRecord);
    expect(messages).toEqual([
      {
        role: "tool",
        toolCallId: "tool-1",
        name: "fs.read",
        ok: true,
        content: "Tool fs.read result (exit=0, ok=true):\nbody",
      },
    ]);
  });

  it("attaches one plan-mode reminder and emits its notice at the milestone", () => {
    const { messages, notices, remindedAt, recorder } = setup();
    const milestone = {
      ...baseRecord,
      isPlanMode: true,
      productiveStep: 15,
      kindHint: "coding" as const,
    };
    recorder.record(milestone);
    recorder.record(milestone);
    expect(remindedAt).toEqual(new Set([15]));
    expect(notices).toEqual([{ level: "info", text: "reminder sent · plan mode" }]);
    expect(messages[0]?.content).toContain("[plan-mode reminder · step 15]");
    expect(messages[1]?.content).not.toContain("[plan-mode reminder · step 15]");
  });

  it("collapses the second identical large body through shared dedupe state", () => {
    const messages: ChatMessage[] = [];
    const recorder = createToolResultRecorder({
      messages,
      useNativeToolHistory: false,
      deferredPostToolMessages: [],
      seenHashes: new Map(),
      remindedAt: new Set(),
      writeNotice: () => undefined,
    });
    const large = "x".repeat(500);
    const record = { ...baseRecord, contextOutput: large };
    recorder.record(record);
    recorder.record(record);
    expect(messages[0]?.content).toContain(large);
    expect(messages[1]?.content).toContain("[duplicate tool output");
    expect(messages[1]?.content).not.toContain(large);
  });

  it("defers image bytes in one internal user message after tool history", () => {
    const { deferredPostToolMessages, recorder } = setup();
    recorder.record({
      ...baseRecord,
      call: { name: "image.view", args: { path: "a.png" } },
      result: {
        ok: true,
        output: "image",
        images: [
          { mediaType: "image/png", dataBase64: "YQ==", path: "a.png" },
          { mediaType: "image/png", dataBase64: "Yg==" },
        ],
      },
    });
    expect(deferredPostToolMessages).toEqual([
      {
        role: "user",
        internal: true,
        content:
          "[image.view] The 2 images you asked to look at are attached to this message, in the order you requested them: a.png, (unnamed). Judge them from the pixels and continue the task.",
        images: [
          { mediaType: "image/png", dataBase64: "YQ==", path: "a.png" },
          { mediaType: "image/png", dataBase64: "Yg==" },
        ],
      },
    ]);
  });
});
