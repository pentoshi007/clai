import { describe, expect, it } from "vitest";
import {
  allToolCallsHaveResults,
  appendAssistantWithTools,
  appendToolResult,
  ensureUniqueToolCallIds,
  expandKeepStartForToolPairs,
  fillMissingToolResults,
  hasOrphanToolMessages,
  missingToolResultIds,
  MAX_RETAINED_COMPLETED_TOOL_ARGUMENT_CHARS,
  projectToolHistory,
  repairToolProtocol,
  toolCallIdsInHistory,
  validateToolProtocol,
} from "../../src/agent/tool-history.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "../../src/llm/reasoning-artifacts.js";
import { createTurnHistoryWriter } from "../../src/agent/turn/history-writer.js";
import { resolveBuiltInProfile } from "../../src/llm/provider-profiles.js";
import type { ChatMessage, NativeToolCall } from "../../src/types.js";

describe("tool-history", () => {
  it("appends assistant then tools with ids", () => {
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "working", [
      { id: "c1", name: "fs.write", args: { path: "a", content: "b" } },
    ]);
    appendToolResult(messages, "c1", "Wrote a", "fs.write", true);
    expect(messages[0]!.role).toBe("assistant");
    expect(messages[0]!.toolCalls?.[0]!.id).toBe("c1");
    expect(messages[1]!.role).toBe("tool");
    expect(messages[1]!.toolCallId).toBe("c1");
    expect(messages[1]!.ok).toBe(true);
    expect(hasOrphanToolMessages(messages)).toBe(false);
    expect(allToolCallsHaveResults(messages)).toBe(true);
  });

  it("detects orphan tool messages", () => {
    const messages: ChatMessage[] = [
      { role: "tool", content: "x", toolCallId: "missing" },
    ];
    expect(hasOrphanToolMessages(messages)).toBe(true);
  });

  it("allows empty text with tools", () => {
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", [
      { id: "c1", name: "fs.list", args: {} },
    ]);
    expect(messages[0]!.content).toBe("");
    expect(messages[0]!.toolCalls).toHaveLength(1);
  });

  it("expands keep window to include tool pairs", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "fs.read", args: { path: "a" } }],
      },
      { role: "tool", toolCallId: "c1", content: "data" },
      { role: "user", content: "u2" },
    ];
    const start = expandKeepStartForToolPairs(messages, 3);
    expect(start).toBeLessThanOrEqual(2);
  });

  it("fillMissingToolResults pairs deferred/omitted ids (P2-4)", () => {
    const calls: NativeToolCall[] = [
      { id: "a", name: "dns.lookup", args: { target: "x" } },
      { id: "b", name: "plan.create", args: { goal: "g", tasks: ["t"] } },
      { id: "c", name: "fs.write", args: { path: "p", content: "x" } },
    ];
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", calls);
    // Only first executed
    appendToolResult(messages, "a", "ok dns", "dns.lookup", true);
    expect(missingToolResultIds(messages).sort()).toEqual(["b", "c"]);
    expect(allToolCallsHaveResults(messages)).toBe(false);

    const filled = fillMissingToolResults(
      messages,
      calls,
      "Deferred — plan.create must wait until reconnaissance results exist.",
    );
    expect(filled).toBe(2);
    expect(missingToolResultIds(messages)).toEqual([]);
    expect(allToolCallsHaveResults(messages)).toBe(true);
    expect(hasOrphanToolMessages(messages)).toBe(false);
    const toolMsgs = messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(3);
    expect(toolMsgs.every((m) => Boolean(m.toolCallId))).toBe(true);
    expect(toolMsgs[1]!.ok).toBe(false);
    expect(toolMsgs[1]!.content).toMatch(/Deferred/);
  });

  it("fillMissing is a no-op when already paired", () => {
    const calls: NativeToolCall[] = [
      { id: "a", name: "fs.read", args: { path: "x" } },
    ];
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", calls);
    appendToolResult(messages, "a", "data", "fs.read", true);
    expect(fillMissingToolResults(messages, calls)).toBe(0);
    expect(messages.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("BoundCall-style parallel id order is stable", () => {
    // Simulate runner BoundCall recording in document order after Promise.all.
    const bound = [
      { index: 0, id: "id-0", name: "dns.lookup" },
      { index: 1, id: "id-1", name: "whois.lookup" },
      { index: 2, id: "id-2", name: "http.fetch" },
    ];
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(
      messages,
      "",
      bound.map((b) => ({ id: b.id, name: b.name, args: {} })),
    );
    // Parallel completion order shuffled, but we record by bound index order.
    const resultsShuffled = [
      { index: 2, content: "http" },
      { index: 0, content: "dns" },
      { index: 1, content: "whois" },
    ];
    for (const b of bound) {
      const r = resultsShuffled.find((x) => x.index === b.index)!;
      appendToolResult(messages, b.id, r.content, b.name, true);
    }
    const tools = messages.filter((m) => m.role === "tool");
    expect(tools.map((t) => t.toolCallId)).toEqual(["id-0", "id-1", "id-2"]);
    expect(allToolCallsHaveResults(messages)).toBe(true);
  });

  it("rejects malformed native groups before provider dispatch", () => {
    const malformed: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "fs.read", args: { path: "a" } },
          { id: "b", name: "fs.read", args: { path: "b" } },
        ],
      },
      { role: "tool", toolCallId: "a", content: "ok" },
      { role: "user", content: "continue" },
      { role: "tool", toolCallId: "unknown", content: "bad" },
    ];
    expect(validateToolProtocol(malformed).join("\n")).toMatch(/before results for b/);
    expect(validateToolProtocol(malformed).join("\n")).toMatch(/orphan tool result unknown/);
  });

  it("repairToolProtocol heals continue-after-partial-tools history", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "fs.read", args: { path: "a" } },
          { id: "b", name: "fs.read", args: { path: "b" } },
          { id: "c", name: "http.fetch", args: { url: "x" } },
        ],
      },
      { role: "tool", toolCallId: "a", content: "ok" },
      { role: "user", content: "continue" },
      { role: "tool", toolCallId: "a", content: "dup orphan" },
      { role: "tool", toolCallId: "unknown", content: "bad" },
    ];
    expect(validateToolProtocol(messages).length).toBeGreaterThan(0);
    const n = repairToolProtocol(messages);
    expect(n).toBeGreaterThan(0);
    expect(validateToolProtocol(messages)).toEqual([]);
    // user continue is still present; missing b/c closed with quiet placeholders
    expect(messages.some((m) => m.role === "user" && m.content === "continue")).toBe(
      true,
    );
    expect(
      messages.filter((m) => m.role === "tool" && m.toolCallId === "b").length,
    ).toBe(1);
    expect(
      messages.filter((m) => m.role === "tool" && m.toolCallId === "unknown").length,
    ).toBe(0);
    // Placeholders must stay boring — no thrash / "platform artifact" bait.
    const repairedB = messages.find((m) => m.role === "tool" && m.toolCallId === "b");
    const body = String(repairedB?.content ?? "");
    expect(repairedB?.ok).toBe(true);
    expect(body).toMatch(/\[context-note\]/i);
    expect(body).not.toMatch(/synthetic/i);
    expect(body).not.toMatch(/closure/i);
    expect(body).not.toMatch(/platform/i);
    expect(body).not.toMatch(/broken/i);
    expect(body).not.toMatch(/exit=130/);
    expect(body).not.toMatch(/history-repair/i);
    expect(body).not.toMatch(/after resume/i);
    expect(body).not.toMatch(/closed incomplete/i);
    expect(body).not.toMatch(/interrupted/i);
  });

  it("ensureUniqueToolCallIds fills empty and duplicate ids", async () => {
    const { ensureUniqueToolCallIds } = await import(
      "../../src/agent/tool-history.js"
    );
    const fixed = ensureUniqueToolCallIds([
      { id: "", name: "fs.list", args: {} },
      { id: "same", name: "fs.read", args: { path: "a" } },
      { id: "same", name: "tool.check", args: { tools: ["node"] } },
    ]);
    expect(fixed[0]!.id.length).toBeGreaterThan(0);
    expect(fixed[1]!.id).toBe("same");
    expect(fixed[2]!.id).not.toBe("same");
    expect(new Set(fixed.map((c) => c.id)).size).toBe(3);
  });

  it("repairToolProtocol keeps live tool bodies when SESSION STATE interleaved mid-group", async () => {
    // Regression: refreshSessionState used to upsert SESSION STATE during
    // executeSingleTool (before recordResult), especially under Promise.all.
    // History became: assistant.toolCalls → SESSION STATE → real tool results.
    // Old repair treated SESSION as interrupting the group, injected
    // "No stored body" placeholders, and dropped the real bodies — models
    // thrash-retried tools that already succeeded in the UI.
    const { SESSION_STATE_PREFIX } = await import("../../src/agent/session-state.js");
    const calls: NativeToolCall[] = [
      { id: "chatcmpl-tool-a", name: "fs.list", args: { path: "/tmp" } },
      { id: "chatcmpl-tool-b", name: "tool.check", args: { tools: ["node"] } },
      { id: "chatcmpl-tool-c", name: "web.search", args: { query: "vite" } },
    ];
    const messages: ChatMessage[] = [
      { role: "system", content: "constitution" },
      { role: "user", content: "build blog" },
    ];
    appendAssistantWithTools(messages, "researching", calls);
    messages.push({
      role: "system",
      content: `${SESSION_STATE_PREFIX}\ngoal: build blog\nflags: feature_needed=true`,
    });
    for (const call of calls) {
      appendToolResult(
        messages,
        call.id,
        `Tool ${call.name} result (exit=0, ok=true):\nREAL BODY for ${call.name}`,
        call.name,
        true,
      );
    }
    expect(validateToolProtocol(messages).length).toBeGreaterThan(0);
    repairToolProtocol(messages);
    expect(validateToolProtocol(messages)).toEqual([]);
    for (const call of calls) {
      const tool = messages.find(
        (m) => m.role === "tool" && m.toolCallId === call.id,
      );
      expect(tool?.content).toContain(`REAL BODY for ${call.name}`);
      expect(tool?.content).not.toMatch(/No stored body/i);
      expect(tool?.content).not.toMatch(/\[context-note\]/i);
    }
    // SESSION STATE kept, but after the tool group (not mid-group).
    const sessionIdx = messages.findIndex(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.startsWith(SESSION_STATE_PREFIX),
    );
    const lastToolIdx = messages
      .map((m, i) => (m.role === "tool" ? i : -1))
      .filter((i) => i >= 0)
      .pop();
    expect(sessionIdx).toBeGreaterThan(lastToolIdx ?? -1);
  });

  it("repairToolProtocol treats cleared injected blocks as benign mid-group", async () => {
    const { AGENT_INSTRUCTIONS_PREFIX, ACTIVE_SKILLS_PREFIX } = await import(
      "../../src/agent/injected-blocks.js"
    );
    const calls: NativeToolCall[] = [
      { id: "chatcmpl-tool-a", name: "fs.list", args: { path: "/tmp" } },
      { id: "chatcmpl-tool-b", name: "tool.check", args: { tools: ["node"] } },
    ];
    const messages: ChatMessage[] = [
      { role: "system", content: "constitution" },
      { role: "user", content: "build blog" },
    ];
    appendAssistantWithTools(messages, "researching", calls);
    messages.push({
      role: "system",
      content: `${AGENT_INSTRUCTIONS_PREFIX}\n(cleared)`,
    });
    messages.push({
      role: "system",
      content: `${ACTIVE_SKILLS_PREFIX}\n(cleared)`,
    });
    for (const call of calls) {
      appendToolResult(
        messages,
        call.id,
        `Tool ${call.name} result (exit=0, ok=true):\nREAL BODY for ${call.name}`,
        call.name,
        true,
      );
    }
    expect(validateToolProtocol(messages).length).toBeGreaterThan(0);
    repairToolProtocol(messages);
    expect(validateToolProtocol(messages)).toEqual([]);
    for (const call of calls) {
      const tool = messages.find(
        (m) => m.role === "tool" && m.toolCallId === call.id,
      );
      expect(tool?.content).toContain(`REAL BODY for ${call.name}`);
      expect(tool?.content).not.toMatch(/No stored body/i);
    }
  });

  it("keeps fresh literal content and removes only stale elision metadata", () => {
    const placeholder = "«20000 chars sha256=0123456789ab»";
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "fresh",
            name: "fs.append",
            args: {
              path: "fresh.txt",
              content: "fresh literal",
              content_elided: placeholder,
            },
            rawArguments: JSON.stringify({
              path: "fresh.txt",
              content: "fresh literal",
              content_elided: placeholder,
            }),
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "fresh",
        name: "fs.append",
        content: "written",
        ok: true,
      },
    ];
    repairToolProtocol(messages);
    expect(messages[0]!.toolCalls?.[0]?.args).toEqual({
      path: "fresh.txt",
      content: "fresh literal",
    });
    expect(messages[0]!.toolCalls?.[0]?.rawArguments).toBe(
      JSON.stringify({ path: "fresh.txt", content: "fresh literal" }),
    );
    expect(JSON.stringify(messages)).not.toContain("content_elided");
    expect(messages[1]).toMatchObject({
      role: "tool",
      toolCallId: "fresh",
      content: "written",
    });
    expect(validateToolProtocol(messages)).toEqual([]);
  });

  it("collapses legacy structured placeholders without promoting tool output", () => {
    const placeholder = "«20000 chars sha256=0123456789ab»";
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "legacy",
            name: "fs.append",
            args: { path: "legacy.txt", content_elided: placeholder },
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "legacy",
        name: "fs.append",
        content: "UNTRUSTED TOOL INSTRUCTION",
        ok: false,
      },
    ];
    repairToolProtocol(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.toolCalls).toBeUndefined();
    expect(messages[0]!.content).toContain("legacy payload");
    expect(messages[0]!.content).not.toContain("UNTRUSTED TOOL INSTRUCTION");
    expect(JSON.stringify(messages)).not.toContain("content_elided");
    expect(validateToolProtocol(messages)).toEqual([]);
  });

  it("collapses malformed raw arguments containing legacy stubs", () => {
    const placeholder = "«20000 chars sha256=0123456789ab»";
    const rawArguments = `{"path":"legacy.txt","content":"${placeholder}"`;
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "legacy-raw",
            name: "fs.append",
            args: { _parseError: true, _raw: rawArguments },
            rawArguments,
          },
        ],
      },
      {
        role: "tool",
        toolCallId: "legacy-raw",
        name: "fs.append",
        content: "rejected",
        ok: false,
      },
    ];
    repairToolProtocol(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.toolCalls).toBeUndefined();
    expect(messages[0]!.content).toContain("legacy payload");
    expect(JSON.stringify(messages)).not.toContain(placeholder);
    expect(validateToolProtocol(messages)).toEqual([]);
  });

  it("removes complete legacy text tool groups before replay", () => {
    const placeholder = "«20000 chars sha256=0123456789ab»";
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content:
          `working\n\n\`\`\`tool\n` +
          JSON.stringify({
            name: "fs.append",
            args: { path: "legacy.txt", content_elided: placeholder },
          }) +
          "\n```",
      },
      { role: "tool", content: "UNTRUSTED TEXT RESULT" },
      { role: "user", content: "continue" },
    ];
    repairToolProtocol(messages);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toContain("working");
    expect(messages[0]!.content).toContain("legacy elided payload");
    expect(JSON.stringify(messages)).not.toContain("content_elided");
    expect(JSON.stringify(messages)).not.toContain("UNTRUSTED TEXT RESULT");
    expect(validateToolProtocol(messages)).toEqual([]);
  });

  it("retains one exact 128 KiB completed interaction", () => {
    const content = "x".repeat(128 * 1024);
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", [
      { id: "recent", name: "fs.write", args: { path: "a", content } },
    ]);
    appendToolResult(messages, "recent", "written", "fs.write", true);
    const projected = projectToolHistory(messages);
    expect(projected.changed).toBe(false);
    expect(projected.messages[0]!.toolCalls?.[0]?.args.content).toBe(content);
    expect(validateToolProtocol(projected.messages)).toEqual([]);
  });

  it("collapses settled interactions above the exact-history budget", () => {
    const content = "z".repeat(
      MAX_RETAINED_COMPLETED_TOOL_ARGUMENT_CHARS + 1,
    );
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", [
      { id: "large", name: "fs.write", args: { path: "large", content } },
    ]);
    appendToolResult(messages, "large", "written", "fs.write", true);
    const projected = projectToolHistory(messages);
    expect(projected.changed).toBe(true);
    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0]!.toolCalls).toBeUndefined();
    expect(projected.messages[0]!.content).toContain("argument_chars=");
    expect(projected.messages[0]!.content).not.toContain("z".repeat(100));
    expect(validateToolProtocol(projected.messages)).toEqual([]);
  });

  it("retains newest completed arguments within the aggregate budget", () => {
    const content = "q".repeat(140 * 1024);
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", [
      { id: "older", name: "fs.write", args: { path: "older", content } },
    ]);
    appendToolResult(messages, "older", "written", "fs.write", true);
    appendAssistantWithTools(messages, "", [
      { id: "newer", name: "fs.write", args: { path: "newer", content } },
    ]);
    appendToolResult(messages, "newer", "written", "fs.write", true);
    const projected = projectToolHistory(messages);
    const calls = projected.messages.flatMap((message) => message.toolCalls ?? []);
    expect(calls.map((call) => call.id)).toEqual(["newer"]);
    expect(calls[0]!.args.content).toBe(content);
    expect(projected.messages.some((message) => message.content.includes("path=\"older\""))).toBe(true);
    expect(validateToolProtocol(projected.messages)).toEqual([]);
  });

  it("retains under-budget canonical text calls and their results", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content:
          '```tool\n{"name":"dns.lookup","args":{"target":"example.com"}}\n```',
      },
      {
        role: "tool",
        content: "Tool dns.lookup result (exit=0, ok=true):\nA 93.184.216.34",
      },
    ];
    const projected = projectToolHistory(messages);
    expect(projected.changed).toBe(false);
    expect(projected.messages).toEqual(messages);
    expect(validateToolProtocol(projected.messages)).toEqual([]);
  });

  it("retains oversized open text calls until a real result exists", () => {
    const content = "u".repeat(
      MAX_RETAINED_COMPLETED_TOOL_ARGUMENT_CHARS + 1,
    );
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: `\`\`\`tool\n${JSON.stringify({
          name: "fs.write",
          args: { path: "open", content },
        })}\n\`\`\``,
      },
    ];
    const projected = projectToolHistory(messages);
    expect(projected.changed).toBe(true);
    expect(projected.messages[0]!.content).toContain(content);
    expect(projected.messages[0]!.content).toContain("```tool");
    expect(projected.messages[0]!.content).not.toContain(
      "settled tool interaction",
    );
    expect(projected.messages[1]!.content).toContain("[context-note]");
    expect(validateToolProtocol(projected.messages)).toEqual([]);
  });

  it("collapses oversized canonical text interactions as whole groups", () => {
    const content = "t".repeat(300 * 1024);
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content:
          `safe prefix\n\n\`\`\`tool\n${JSON.stringify({
            name: "fs.write",
            args: { path: "text-large", content },
          })}\n\`\`\`\n\nsafe suffix`,
      },
      { role: "tool", content: "written", ok: true },
    ];
    const projected = projectToolHistory(messages);
    expect(projected.changed).toBe(true);
    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0]!.content).toContain("safe prefix");
    expect(projected.messages[0]!.content).toContain("safe suffix");
    expect(projected.messages[0]!.content).toContain("argument_chars=");
    expect(projected.messages[0]!.content).not.toContain("```tool");
    expect(projected.messages[0]!.content).not.toContain("t".repeat(100));
    expect(JSON.stringify(projected.messages).length).toBeLessThan(4096);
    expect(validateToolProtocol(projected.messages)).toEqual([]);
  });

  it("shares one newest-first argument budget across native and text groups", () => {
    const olderContent = "o".repeat(140 * 1024);
    const newerContent = "n".repeat(140 * 1024);
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", [
      {
        id: "older-native",
        name: "fs.write",
        args: { path: "older", content: olderContent },
      },
    ]);
    appendToolResult(messages, "older-native", "written", "fs.write", true);
    messages.push(
      {
        role: "assistant",
        content: `\`\`\`tool\n${JSON.stringify({
          name: "fs.write",
          args: { path: "newer", content: newerContent },
        })}\n\`\`\``,
      },
      { role: "tool", content: "written", ok: true },
    );
    const projected = projectToolHistory(messages);
    expect(projected.changed).toBe(true);
    expect(projected.messages.flatMap((message) => message.toolCalls ?? [])).toEqual([]);
    expect(projected.messages.some((message) => message.content.includes('path="older"'))).toBe(true);
    const retainedText = projected.messages.find((message) =>
      message.content.includes("```tool"),
    );
    expect(retainedText?.content).toContain(newerContent);
    expect(retainedText?.content).not.toContain(olderContent);
    expect(validateToolProtocol(projected.messages)).toEqual([]);
  });

  it("bounds every target copied into settled receipts", () => {
    const path = "p".repeat(300 * 1024);
    const files = Array.from({ length: 8 }, (_, index) => ({
      path: `${index}${"f".repeat(64 * 1024)}`,
      content: "x",
    }));
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", [
      { id: "large-path", name: "fs.write", args: { path, content: "x" } },
      { id: "large-paths", name: "fs.writeMany", args: { files } },
    ]);
    appendToolResult(messages, "large-path", "written", "fs.write", true);
    appendToolResult(messages, "large-paths", "written", "fs.writeMany", true);
    const projected = projectToolHistory(messages);
    const serialized = JSON.stringify(projected.messages);
    expect(projected.changed).toBe(true);
    expect(serialized.length).toBeLessThan(12_000);
    expect(serialized).toContain("307200 chars sha256=");
    expect(serialized).toContain("65537 chars sha256=");
    expect(serialized).not.toContain("p".repeat(100));
    expect(serialized).not.toContain("f".repeat(100));
    expect(validateToolProtocol(projected.messages)).toEqual([]);
  });

  it("accepts complete parallel native groups in any result order", () => {
    const calls: NativeToolCall[] = Array.from({ length: 16 }, (_, index) => ({
      id: `call-${index}`,
      name: "fs.read",
      args: { path: String(index) },
    }));
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", calls);
    for (const call of [...calls].reverse()) {
      appendToolResult(messages, call.id, "ok", call.name, true);
    }
    expect(validateToolProtocol(messages)).toEqual([]);
  });
});

describe("reasoning signature adjacency (T620)", () => {
  const signatureArtifact = (signature: string, toolCallId: string, toolCallIndex: number) =>
    createReasoningArtifact({
      kind: "thought-signature",
      raw: signature,
      provenance: createReasoningArtifactProvenance({
        provider: "anthropic",
        model: "claude-test",
        dialect: "anthropic-thinking",
      }),
      replay: { scope: "tool-turn", persistence: "tool-turn" },
      position: { sequence: 0, placement: "before-tool-call", toolCallId, toolCallIndex },
    });

  it("drops removed-call artifacts and reindexes the surviving owner", () => {
    const placeholder = "«20000 chars sha256=0123456789ab»";
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(
      messages,
      "",
      [
        {
          id: "removed",
          name: "fs.append",
          args: { path: "legacy.txt", content_elided: placeholder },
        },
        {
          id: "survivor",
          name: "fs.read",
          args: { path: "current.txt" },
        },
      ],
      undefined,
      [
        signatureArtifact("sig-removed", "removed", 0),
        signatureArtifact("sig-survivor", "survivor", 1),
      ],
    );
    appendToolResult(messages, "removed", "rejected", "fs.append", false);
    appendToolResult(messages, "survivor", "current", "fs.read", true);
    const projected = projectToolHistory(messages);
    const assistant = projected.messages.find(
      (message) => message.role === "assistant" && message.toolCalls?.length,
    );
    expect(assistant?.toolCalls?.map((call) => call.id)).toEqual(["survivor"]);
    expect(assistant?.reasoningArtifacts?.map((artifact) => artifact.raw)).toEqual([
      "sig-survivor",
    ]);
    expect(assistant?.reasoningArtifacts?.[0]?.position).toMatchObject({
      toolCallId: "survivor",
      toolCallIndex: 0,
    });
    expect(JSON.stringify(projected.messages)).not.toContain("sig-removed");
    expect(validateToolProtocol(projected.messages)).toEqual([]);
  });

  it("keeps every signature on its exact occurrence when duplicate wire ids are rewritten", () => {
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", [
      { id: "dupe", name: "fs.read", args: { path: "first" } },
    ]);
    appendToolResult(messages, "dupe", "first body", "fs.read", true);

    const rewritten = ensureUniqueToolCallIds(
      [
        { id: "dupe", name: "fs.read", args: { path: "second" } },
        { id: "fresh", name: "fs.read", args: { path: "third" } },
      ],
      toolCallIdsInHistory(messages),
    );
    expect(rewritten[0]!.id).not.toBe("dupe");
    expect(rewritten[1]!.id).toBe("fresh");

    appendAssistantWithTools(
      messages,
      "",
      rewritten,
      undefined,
      [
        signatureArtifact("sig-second", "dupe", 0),
        signatureArtifact("sig-third", "fresh", 1),
      ],
    );
    const persisted = messages.at(-1)!.reasoningArtifacts!;
    const boundIds = persisted
      .filter((artifact) => artifact.position.placement === "before-tool-call")
      .map((artifact) => artifact.position.toolCallId);
    expect(boundIds).toEqual([rewritten[0]!.id, "fresh"]);
    for (const artifact of persisted) {
      const owner = rewritten.find(
        (call) => call.id === artifact.position.toolCallId,
      );
      expect(owner).toBeDefined();
      expect(artifact.raw).toBe(
        owner!.args.path === "second" ? "sig-second" : "sig-third",
      );
    }
  });

  it("keeps pairing valid when a replayed occurrence gets a synthetic id", () => {
    const messages: ChatMessage[] = [];
    appendAssistantWithTools(messages, "", [
      { id: "gateway-reuse", name: "fs.list", args: { path: "." } },
    ]);
    appendToolResult(messages, "gateway-reuse", "listed once", "fs.list", true);
    const rewritten = ensureUniqueToolCallIds(
      [{ id: "gateway-reuse", name: "fs.list", args: { path: "." } }],
      toolCallIdsInHistory(messages),
    );
    expect(rewritten[0]!.id).not.toBe("gateway-reuse");
    appendAssistantWithTools(messages, "", rewritten);
    appendToolResult(messages, rewritten[0]!.id, "replayed result", "fs.list", true);
    expect(hasOrphanToolMessages(messages)).toBe(false);
    expect(allToolCallsHaveResults(messages)).toBe(true);
    expect(validateToolProtocol(messages)).toEqual([]);
  });

  it("preserves reasoning artifacts when pushing assistant history with tool calls", () => {
    const messages: ChatMessage[] = [];
    const writer = createTurnHistoryWriter({
      messages,
      sanitizeAssistantText: (t) => t,
      visibleCommitted: () => false,
      writeAssistantMessage: () => {},
    });
    const artifact = createReasoningArtifact({
      kind: "plaintext",
      raw: "deep reasoning steps",
      provenance: createReasoningArtifactProvenance({
        provider: "hetzner",
        dialect: "openai-compatible",
      }),
      replay: { scope: "tool-turn", persistence: "tool-turn" },
      position: { sequence: 0, placement: "assistant" },
    });
    writer.pushAssistantHistory(
      '```tool\n{"name":"fs.list","args":{}}\n```',
      {
        reasoningBlock: { text: "deep reasoning steps" },
        reasoningArtifacts: [artifact],
      },
      true,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.reasoningArtifacts).toHaveLength(1);
    expect(messages[0]!.reasoningArtifacts![0]!.raw).toBe("deep reasoning steps");
    expect(messages[0]!.reasoningBlock?.text).toBe("deep reasoning steps");
  });

  it("omits tool-turn reasoning artifacts when pushing assistant history without tool calls", () => {
    const messages: ChatMessage[] = [];
    const writer = createTurnHistoryWriter({
      messages,
      sanitizeAssistantText: (t) => t,
      visibleCommitted: () => false,
      writeAssistantMessage: () => {},
    });
    const artifact = createReasoningArtifact({
      kind: "plaintext",
      raw: "final reasoning steps",
      provenance: createReasoningArtifactProvenance({
        provider: "hetzner",
        dialect: "openai-compatible",
      }),
      replay: { scope: "tool-turn", persistence: "tool-turn" },
      position: { sequence: 0, placement: "assistant" },
    });
    writer.pushAssistantHistory("Here is the answer", {
      reasoningBlock: { text: "final reasoning steps" },
      reasoningArtifacts: [artifact],
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.reasoningArtifacts).toBeUndefined();
    expect(messages[0]!.reasoningBlock).toBeUndefined();
  });

  it("configures replayScope as tool-turn for hetzner qwen models", () => {
    const profile = resolveBuiltInProfile({
      provider: "hetzner",
      model: "Qwen/Qwen3.6-35B-A3B-FP8",
    });
    expect(profile.reasoning.replayScope).toBe("tool-turn");
  });
});
