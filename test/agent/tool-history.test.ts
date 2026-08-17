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
  repairToolProtocol,
  toolCallIdsInHistory,
  validateToolProtocol,
} from "../../src/agent/tool-history.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
} from "../../src/llm/reasoning-artifacts.js";
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
});
