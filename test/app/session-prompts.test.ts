import { readFile, stat } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import type { RunTurnRequest } from "../../src/app/ports/agent-port.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import type { ChatMessage } from "../../src/types.js";

const sessions: SessionController[] = [];
const initialConfig = getConfig();

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  updateConfig({ privateMode: initialConfig.privateMode, thinking: initialConfig.thinking });
  vi.restoreAllMocks();
});

function makeSession(options: {
  noHistory?: boolean;
  complete?: (messages: ChatMessage[]) => Promise<string>;
} = {}) {
  const requests: RunTurnRequest[] = [];
  const names: (string | undefined)[] = [];
  const namingCalls: ChatMessage[][] = [];
  const notices: string[] = [];
  const session = new SessionController({
    sessionId: `prompt-test-${Math.random().toString(36).slice(2)}`,
    provider: "codex", model: "test-codex-model", noHistory: options.noHistory,
    clock: { now: () => 1791110400000 },
    agent: { async runTurn(request, handlers) {
      requests.push(request);
      handlers.onMessages?.([
        ...(request.history ?? []), { role: "user", content: request.prompt },
        { role: "assistant", content: "Private assistant implementation details" },
      ]);
      return createTurnOutcome({ status: "succeeded", answer: "ok", steps: 1, remainingCriteria: [] });
    } },
    persistence: {
      async saveSession(_messages, opts) { names.push(opts?.name); },
      async loadPlan() { return undefined; }, async savePlan() {}, async deletePlan() {},
    },
    titleCompleter: async (messages) => {
      namingCalls.push(messages);
      return options.complete ? options.complete(messages) : "SUMMARY: prompt tasks\nTITLE: User prompt tasks";
    },
    emit: (event) => { if (event.type === "notice") notices.push(event.payload.text); },
  });
  sessions.push(session);
  return { session, requests, names, namingCalls, notices };
}

describe("session prompt capture and naming", () => {
  it("captures each sent prompt and its current provider/model/effort without assistant text", async () => {
    updateConfig({ privateMode: false, thinking: { enabled: true, effort: "xhigh" } });
    const { session, namingCalls, names } = makeSession();
    await session.submit("Fix the cache prefix\nPreserve all request settings");
    await expect.poll(() => namingCalls.length).toBe(1);
    session.setProvider("openai");
    session.setModel("second-model");
    updateConfig({ thinking: { enabled: false, effort: "high" } });
    await session.submit("Research compaction only");
    await expect.poll(() => namingCalls.length).toBe(2);
    await expect.poll(() => names.includes("User prompt tasks")).toBe(true);
    const body = await readFile(session.promptHistory.path, "utf8");
    for (const detail of ["2026", "codex", "test-codex-model", "xhigh", "openai", "second-model", "off"]) expect(body).toContain(detail);
    expect(body).toContain("Fix the cache prefix\n> Preserve all request settings");
    expect(body).not.toContain("Private assistant");
    const naming = namingCalls.at(-1)![1]!.content;
    expect(naming).toContain("Fix the cache prefix");
    expect(naming).toContain("Research compaction only");
    expect(naming).not.toContain("Private assistant");
  });

  it("records edited queued prompts once when dispatched, using the route at dispatch", async () => {
    const { session } = makeSession();
    session.enqueue("removed prompt");
    session.removeQueued(0);
    session.enqueue("queued draft");
    session.editQueued(0, "edited final prompt");
    expect(await session.promptHistory.count()).toBe(0);
    session.setProvider("anthropic");
    session.setModel("queued-model");
    await session.drain();
    expect(await session.promptHistory.count()).toBe(1);
    const body = await readFile(session.promptHistory.path, "utf8");
    expect(body).toContain("edited final prompt");
    expect(body).toContain("queued-model");
    expect(body).not.toContain("removed prompt");
    expect(body).not.toContain("queued draft");
  });

  it("excludes responder, plan execution, and internal recovery turns", async () => {
    const { session, namingCalls } = makeSession();
    await session.submit("automatic responder", { displayPrompt: null });
    await session.submit("automatic recovery", { displayPrompt: "Recovery", internal: true });
    await session.submit("Plan approved. Execute the plan");
    expect(await session.promptHistory.count()).toBe(0);
    expect(namingCalls).toHaveLength(0);
    await session.submit("Plan revision request from the user: improve it", { displayPrompt: "Please improve the plan" });
    expect((await session.promptHistory.namingWindow()).prompts).toEqual([{ number: 1, preview: "Please improve the plan" }]);
  });

  it.each(["private", "noHistory"] as const)("respects %s mode while the main agent remains usable", async (mode) => {
    updateConfig({ privateMode: mode === "private" });
    const { session, namingCalls } = makeSession({ noHistory: mode === "noHistory" });
    expect((await session.submit("Private user prompt")).status).toBe("completed");
    expect(await session.promptHistory.count()).toBe(0);
    await expect(stat(session.promptHistory.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(namingCalls).toHaveLength(0);
  });

  it("does not wait for a slow naming request or inject prompt history into main requests", async () => {
    let release!: (text: string) => void;
    const { session, requests, namingCalls } = makeSession({
      complete: () => new Promise((resolve) => { release = resolve; }),
    });
    expect((await session.submit("First user task")).status).toBe("completed");
    await expect.poll(() => namingCalls.length).toBe(1);
    const prior = [...session.messages];
    expect((await session.submit("Second user task")).status).toBe("completed");
    expect(requests[1]!.history).toEqual(prior);
    expect(JSON.stringify(requests)).not.toContain("Session prompts");
    expect(JSON.stringify(requests)).not.toContain("Previous summary");
    expect(namingCalls).toHaveLength(1);
    release("TITLE: Old first task");
    await expect.poll(() => namingCalls.length).toBe(2);
    expect(namingCalls[1]![1]!.content).toContain("Second user task");
    expect(session.getState().title).not.toBe("Old first task");
    release("TITLE: Both user tasks");
    await expect.poll(() => session.getState().title).toBe("Both user tasks");
  });

  it("preserves all recorded prompts when compaction removes raw history and the session reloads", async () => {
    const { session } = makeSession();
    await session.submit("Early authentication work");
    await session.submit("Latest compaction research");
    const memory: ChatMessage[] = [{ role: "system", content: "Compacted context: research findings" }];
    session.restoreMessages(memory);
    session.loadHistory(memory, { sessionId: session.sessionId, title: "Compaction" });
    await session.promptHistory.flush();
    expect(await session.promptHistory.count()).toBe(2);
    await session.submit("Continue only the research");
    const window = await session.promptHistory.namingWindow();
    expect(window.prompts.map((entry) => entry.preview)).toEqual([
      "Early authentication work", "Latest compaction research", "Continue only the research",
    ]);
  });

  it("imports available legacy user prompts once, including nested compacted transcripts", async () => {
    const { session, namingCalls } = makeSession();
    const messages: ChatMessage[] = [{ role: "user", content: "Latest old question" }];
    session.loadHistory(messages, { title: "Loaded title", transcript: [
      { kind: "compacted", id: "older", summary: "old", done: true, originalItems: [
        { kind: "user", id: "early", text: "Implement authentication", done: true },
        { kind: "thinking", id: "secret", content: "Private reasoning", done: true },
        { kind: "assistant", id: "answer", text: "Private answer", streaming: false, done: true },
      ] },
      { kind: "user", id: "later", text: "Latest old question", done: true },
    ] });
    await session.promptHistory.flush();
    expect(await session.promptHistory.count()).toBe(2);
    expect(namingCalls).toHaveLength(0);
    const body = await readFile(session.promptHistory.path, "utf8");
    expect(body).toContain("unknown · imported from saved history");
    expect(body).not.toContain("Private reasoning");
    await session.submit("Now research caching");
    await expect.poll(() => namingCalls.length).toBe(1);
    expect(namingCalls[0]![1]!.content).toContain("Implement authentication");
    expect(namingCalls[0]![1]!.content).toContain("Latest old question");
    expect(namingCalls[0]![1]!.content).toContain("Loaded title");
  });

  it("isolates a new session's journal and ignores a late name from the old session", async () => {
    let release!: (text: string) => void;
    const { session, namingCalls } = makeSession({ complete: () => new Promise((resolve) => { release = resolve; }) });
    await session.submit("Old session prompt");
    await expect.poll(() => namingCalls.length).toBe(1);
    const oldStore = session.promptHistory;
    session.reset({ mintNewId: true });
    release("TITLE: Old session title");
    await new Promise((resolve) => setImmediate(resolve));
    expect(session.getState().title).toBeUndefined();
    expect(await session.promptHistory.count()).toBe(0);
    expect(await oldStore.count()).toBe(1);
    expect(session.promptHistory.path).not.toBe(oldStore.path);
  });

  it("keeps main turns working after a prompt journal write fails", async () => {
    const { session, namingCalls, notices } = makeSession();
    vi.spyOn(session.promptHistory, "append").mockRejectedValue(new Error("disk full"));
    expect((await session.submit("First request")).status).toBe("completed");
    expect((await session.submit("Second request")).status).toBe("completed");
    expect(namingCalls).toHaveLength(0);
    expect(notices.filter((text) => text.includes("could not save session prompts"))).toHaveLength(1);
  });
});
