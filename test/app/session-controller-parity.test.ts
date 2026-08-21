import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPACTION_MAX_COMPLETION_TOKENS } from "../../src/agent/compaction-summary.js";
import type { AgentPort } from "../../src/app/ports/agent-port.js";
import type { SuccessfulRequestSnapshot } from "../../src/types.js";
import type {
  PersistencePort,
  SaveSessionOptions,
} from "../../src/app/ports/persistence-port.js";
import {
  isCompactionMemoryMessage,
} from "../../src/agent/context-manager.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import { createContextSnapshot } from "../../src/llm/context-snapshot.js";
import { createTurnOutcome } from "../../src/agent/turn-outcome.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";

const completeWithProvider = vi.fn();
vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    completeWithProvider: (...args: unknown[]) => completeWithProvider(...args),
    streamWithProvider: async (
      request: unknown,
      onToken: (text: string) => void,
    ) => {
      const result = await completeWithProvider(request);
      const chunks = Array.isArray(result.chunks)
        ? result.chunks
        : [result.text];
      for (const chunk of chunks) onToken(String(chunk));
      return result;
    },
  };
});

function fakePersistence(): PersistencePort {
  return {
    async saveSession() {},
    async loadPlan() {
      return undefined;
    },
    async savePlan() {},
    async deletePlan() {},
  };
}

function fakeAgent(): AgentPort {
  return {
    async runTurn(_req, handlers) {
      handlers.onMessages?.([{ role: "user", content: "x" }, { role: "assistant", content: "y" }]);
      return createTurnOutcome({ status: "succeeded", answer: "y", steps: 1, remainingCriteria: [] });
    },
  };
}

function primeCompactionSnapshot(session: SessionController): void {
  const history = session.messages.map((message) => structuredClone(message));
  const snapshot: SuccessfulRequestSnapshot = {
    provider: "nvidia",
    model: "test-model",
    messages: [
      { role: "system", content: "main system prompt" },
      ...history.slice(0, -1),
    ],
    temperature: 0.2,
    thinking: { enabled: true, effort: "medium" },
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
  (
    session as unknown as {
      lastMainRequestSnapshot: SuccessfulRequestSnapshot | undefined;
    }
  ).lastMainRequestSnapshot = snapshot;
}

function renderedCompaction(events: readonly AnyAppEvent[]): string {
  return events.reduce((summary, event) => {
    if (event.type !== "compaction-delta") return summary;
    return event.payload.replace
      ? event.payload.text
      : summary + event.payload.text;
  }, "");
}

describe("SessionController parity helpers (V2-080)", () => {
  beforeEach(() => {
    completeWithProvider.mockReset();
    completeWithProvider.mockResolvedValue({
      text: "User goals: resumed work. Work completed: history + follow-up.",
    });
  });

  it("notice emits a typed notice AppEvent", () => {
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (e) => events.push(e),
    });
    session.notice("info", "hello");
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("notice");
    if (events[0]?.type === "notice") {
      expect(events[0].payload).toEqual({ level: "info", text: "hello" });
    }
  });

  it("allow/disallow mutate the session allow set", () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
    });
    session.allowTool("fs.write");
    expect(session.allowedTools()).toEqual(["fs.write"]);
    session.disallowTool("fs.write");
    expect(session.allowedTools()).toEqual([]);
  });

  it("reset clears history, queue, and spool", async () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
    });
    await session.submit("hi");
    session.enqueue("queued");
    session.spool.append("tool-1" as never, "out");
    session.reset();
    expect(session.messages).toHaveLength(0);
    expect(session.queued()).toHaveLength(0);
    expect(session.spool.tail("tool-1" as never)).toBe("");
  });

  it("reset({ mintNewId: true }) changes the session id", () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
      sessionId: "sess-old",
    });
    expect(session.sessionId).toBe("sess-old");
    session.reset({ mintNewId: true });
    expect(session.sessionId).not.toBe("sess-old");
  });

  it("estimateContext reports message count", async () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
    });
    await session.submit("hi");
    const est = session.estimateContext();
    expect(est.messages).toBe(2);
    expect(est.tokens).toBeGreaterThan(0);
  });

  it("exposes estimated context before the first model turn", () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
      provider: "modal" as never,
      model: "moonshotai/Kimi-K3",
    });
    const state = session.getState();
    expect(state.contextUsage).toMatchObject({
      contextTokens: 0,
      exact: false,
    });
    expect(state.contextChip).toBe("ctx:~0");
  });

  it("setPlanApproved is readable via isPlanApproved", () => {
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: () => {},
    });
    expect(session.isPlanApproved()).toBe(false);
    session.setPlanApproved(true);
    expect(session.isPlanApproved()).toBe(true);
  });

  it("compact is rejected while a turn is running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent: AgentPort = {
      async runTurn(_req, handlers) {
        await gate;
        handlers.onMessages?.([]);
        return createTurnOutcome({ status: "succeeded", answer: "", steps: 1, remainingCriteria: [] });
      },
    };
    const session = new SessionController({
      agent,
      persistence: fakePersistence(),
      emit: () => {},
    });
    const running = session.submit("long");
    await expect(session.compact()).rejects.toThrow(/already running/);
    release();
    await running;
  });

  it("compact after loadHistory summarizes resumed history + newer turns", async () => {
    const visibleSummary =
      "User goals: resumed work. Work completed: history + follow-up.";
    completeWithProvider.mockResolvedValueOnce({
      text: `<thinking>hidden compaction reasoning</thinking>${visibleSummary}`,
      chunks: [
        "<think",
        "ing>hidden compaction reasoning</think",
        `ing>${visibleSummary.slice(0, 24)}`,
        visibleSummary.slice(24),
      ],
    });
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (e) => events.push(e),
      sessionId: "sess-hist-compact",
      provider: "nvidia" as never,
      model: "test-model",
    });

    // /history resume with prior conversation.
    session.loadHistory(
      [
        { role: "user", content: "history prompt one" },
        { role: "assistant", content: "history answer one" },
        { role: "user", content: "follow-up after resume" },
        { role: "assistant", content: "follow-up answer" },
      ],
      { sessionId: "sess-hist-compact" },
    );

    const visual =
      "USER INTENT/PROMPT:\nhistory prompt one\n\n---\n\n" +
      "ASSISTANT RESPONSE:\nhistory answer one\n\n---\n\n" +
      "USER INTENT/PROMPT:\nfollow-up after resume\n\n---\n\n" +
      "ASSISTANT RESPONSE:\nfollow-up answer";

    primeCompactionSnapshot(session);
    const result = await session.compact(visual, 2);
    expect(result.summarized).toBe(true);
    expect(completeWithProvider).toHaveBeenCalled();
    const request = completeWithProvider.mock.calls[0]?.[0] as {
      messages?: Array<{ role: string; content: string }>;
    };
    expect(request.messages?.map((message) => message.content)).toContain(
      "history prompt one",
    );
    expect(request.messages?.map((message) => message.content)).toContain(
      "follow-up after resume",
    );
    expect(request.messages?.at(-1)?.content).toContain(
      "entire conversation above this instruction",
    );
    // Recent tail kept; memory inserted.
    expect(session.messages.slice(-2).map((m) => m.content)).toEqual([
      "follow-up after resume",
      "follow-up answer",
    ]);
    expect(
      session.messages.some(
        (m) =>
          m.role === "system" &&
          m.content.includes("Session memory from compacted earlier turns"),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === "compaction-completed")).toBe(true);
    const streamedSummary = renderedCompaction(events);
    expect(streamedSummary).toBe(visibleSummary);
    expect(streamedSummary).not.toMatch(/<\/?think|hidden compaction/i);
    const completed = events.find(
      (event) => event.type === "compaction-completed",
    );
    if (completed?.type === "compaction-completed") {
      expect(completed.payload.summary).toContain(visibleSummary);
      expect(completed.payload.summary).not.toMatch(/<\/?think|hidden compaction/i);
      expect(completed.payload.contextScope).toBe("assembled-request");
    }
    expect(session.getState().contextSnapshot).toMatchObject({
      scope: "assembled-request",
      precision: "estimate",
    });
  });

  it("fails closed after one reasoning-only manual summary", async () => {
    completeWithProvider.mockResolvedValueOnce({
      text: "<think>reasoning consumed the allowance</think>",
      chunks: ["<thi", "nk>reasoning consumed the allowance</think>"],
    });
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (event) => events.push(event),
      sessionId: "sess-thinking-retry",
      provider: "nvidia" as never,
      model: "thinking-model",
    });
    session.loadHistory(
      [
        { role: "user", content: "build the feature" },
        { role: "assistant", content: "implementation started" },
        { role: "user", content: "keep the original context safe" },
        { role: "assistant", content: "continuing" },
      ],
      { sessionId: "sess-thinking-retry" },
    );
    const original = session.messages.map((message) => ({ ...message }));
    primeCompactionSnapshot(session);

    await expect(session.compact(undefined, 2)).rejects.toThrow(
      /no visible summary/i,
    );

    expect(completeWithProvider).toHaveBeenCalledTimes(1);
    expect(completeWithProvider.mock.calls[0]?.[0]).toMatchObject({
      maxTokens: COMPACTION_MAX_COMPLETION_TOKENS,
      temperature: 0.2,
      thinking: { enabled: true, effort: "medium" },
      toolChoice: "auto",
      parallelToolCalls: true,
    });
    expect(renderedCompaction(events)).toBe("");
    expect(session.messages).toEqual(original);
  });

  it("fails closed after one output-limited manual summary", async () => {
    completeWithProvider.mockResolvedValueOnce({
      text: "## User goals\nPreserve the session.\n## Remaining work\nContinue with",
      chunks: ["## User goals\nPreserve the session.", "\n## Remaining work\nContinue with"],
      finishReason: "length",
      usage: { completionTokens: COMPACTION_MAX_COMPLETION_TOKENS },
    });
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (event) => events.push(event),
      sessionId: "sess-length-retry",
      provider: "nvidia" as never,
      model: "thinking-model",
    });
    session.loadHistory(
      [
        { role: "user", content: "build the feature" },
        { role: "assistant", content: "implementation started" },
        { role: "user", content: "preserve the context" },
        { role: "assistant", content: "continuing" },
      ],
      { sessionId: "sess-length-retry" },
    );
    const original = session.messages.map((message) => ({ ...message }));
    primeCompactionSnapshot(session);

    await expect(session.compact(undefined, 2)).rejects.toThrow(
      /summary output limit/i,
    );
    expect(completeWithProvider).toHaveBeenCalledTimes(1);
    expect(renderedCompaction(events)).toContain("Continue with");
    expect(session.messages).toEqual(original);
  });

  it("keeps the exact original messages when a manual summary contains only reasoning", async () => {
    completeWithProvider
      .mockResolvedValueOnce({
        text: "<think>first hidden-only summary</think>",
        chunks: ["<think>first hidden-only summary</think>"],
      })
      .mockResolvedValueOnce({
        text: "<thinking>retry was still hidden-only</thinking>",
      });
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (event) => events.push(event),
      sessionId: "sess-thinking-failure",
      provider: "nvidia" as never,
      model: "thinking-model",
    });
    session.loadHistory(
      [
        { role: "user", content: "original user context" },
        { role: "assistant", content: "original assistant context" },
        { role: "user", content: "recent user context" },
        { role: "assistant", content: "recent assistant context" },
      ],
      { sessionId: "sess-thinking-failure" },
    );
    const original = session.messages.map((message) => ({ ...message }));
    primeCompactionSnapshot(session);

    await expect(session.compact(undefined, 2)).rejects.toThrow(
      /no visible summary/i,
    );

    expect(completeWithProvider).toHaveBeenCalledTimes(1);
    expect(session.messages).toEqual(original);
    expect(events.some((event) => event.type === "compaction-completed")).toBe(
      false,
    );
    expect(
      events
        .filter((event) => event.type === "compaction-delta")
        .map((event) => event.payload.text)
        .join(""),
    ).toBe("");
    const started = events.find(
      (event) => event.type === "compaction-started",
    );
    const failed = events.find((event) => event.type === "compaction-failed");
    expect(failed?.type).toBe("compaction-failed");
    if (started?.type === "compaction-started" && failed?.type === "compaction-failed") {
      expect(failed.payload.retainedTokens).toBe(started.payload.beforeTokens);
      expect(failed.payload.retainedTokens).toBeGreaterThan(0);
    }
  });

  it("persists after compaction even when the kept tail has no user message (trailing compacted card survives reload)", async () => {
    const saved: Array<
      readonly { role: string; content: string }[]
    > = [];
    const persistence: PersistencePort = {
      async saveSession(messages) {
        saved.push(messages.map((m) => ({ role: m.role, content: m.content })));
      },
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    };
    const session = new SessionController({
      agent: fakeAgent(),
      persistence,
      emit: () => {},
      sessionId: "sess-tail-no-user",
    });
    // Older turns get summarized; the kept tail is assistant-only (no user),
    // which previously tripped the persistNow user-message guard.
    session.loadHistory(
      [
        { role: "user", content: "build the app " + "x".repeat(400) },
        { role: "assistant", content: "starting the build " + "x".repeat(400) },
        { role: "assistant", content: "recent assistant one" },
        { role: "assistant", content: "recent assistant two" },
      ],
      { sessionId: "sess-tail-no-user" },
    );

    primeCompactionSnapshot(session);
    const result = await session.compact(undefined, 2);

    expect(result.summarized).toBe(true);
    expect(session.messages.some(isCompactionMemoryMessage)).toBe(true);
    expect(session.messages.some((m) => m.role === "user")).toBe(false);
    expect(saved.length).toBeGreaterThan(0);
    expect(
      saved.at(-1)?.some((m) => m.content.includes("Session memory from compacted")),
    ).toBe(true);
  });

  it("emits the PLAN MODE HANDOFF memory instead of a generic compacted label", async () => {
    completeWithProvider.mockResolvedValueOnce({
      text: "## Research evidence\nVerified React project state\n## Current state\nReady to implement",
    });
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (event) => events.push(event),
      sessionId: "sess-plan-handoff",
    });
    session.loadHistory(
      [
        {
          role: "system",
          content:
            "Session memory from compacted earlier turns:\n\nstale resumed memory",
        },
        { role: "user", content: "research the app" },
        { role: "assistant", content: "research result" },
        { role: "user", content: "use glassmorphism" },
        { role: "assistant", content: "plan revised" },
      ],
      { sessionId: "sess-plan-handoff" },
    );

    primeCompactionSnapshot(session);
    await session.compact(undefined, 2, undefined, {
      purpose: "plan-implement",
    });

    const compactionInstruction = String(
      completeWithProvider.mock.calls.at(-1)?.[0]?.messages?.at(-1)?.content ?? "",
    );
    expect(compactionInstruction).toMatch(/Do not add (?:another )?framing/);
    expect(compactionInstruction).not.toContain("State clearly that this context");
    const compacted = events.find(
      (event) => event.type === "compaction-completed",
    );
    expect(compacted?.type).toBe("compaction-completed");
    if (compacted?.type === "compaction-completed") {
      expect(compacted.payload.summary).toContain("PLAN MODE HANDOFF");
      expect(compacted.payload.summary).toContain("Verified React project state");
      expect(compacted.payload.summary).not.toContain("stale resumed memory");
      expect(compacted.payload.summary).not.toBe("Compacted context");
    }
    const memories = session.messages.filter(isCompactionMemoryMessage);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.content).toContain("Verified React project state");
  });

  it("serializes stale autosave and compacted snapshots in revision order", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const saved: Array<{
      messages: readonly { role: string; content: string }[];
      options: Parameters<PersistencePort["saveSession"]>[1];
    }> = [];
    let activeWrites = 0;
    let maxActiveWrites = 0;
    let callCount = 0;
    const persistence: PersistencePort = {
      async saveSession(messages, options) {
        callCount += 1;
        activeWrites += 1;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        if (callCount === 1) {
          markFirstStarted();
          await firstGate;
        }
        saved.push({
          messages: messages.map((message) => ({ ...message })),
          options: options ? { ...options } : undefined,
        });
        activeWrites -= 1;
      },
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    };
    let transcript: unknown[] = [
      { kind: "user", id: "u-old", text: "resumed task", done: true },
    ];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence,
      emit: (event) => {
        if (event.type === "compaction-completed") {
          transcript = [
            {
              kind: "compacted",
              id: "compact-new",
              summary: event.payload.summary,
              originalItems: [],
              done: true,
            },
          ];
        }
      },
      getTranscriptSnapshot: () => transcript as never,
      sessionId: "sess-ordered-compact",
      provider: "nvidia" as never,
      model: "test-model",
    });
    session.loadHistory(
      [
        { role: "user", content: "resumed task" },
        { role: "assistant", content: "old progress" },
        { role: "user", content: "post-resume work" },
        { role: "assistant", content: "new progress" },
      ],
      {
        sessionId: "sess-ordered-compact",
        persistenceRevision: 7,
        contextUsage: {
          contextTokens: 88_000,
          contextLimit: 128_000,
          exact: true,
          contextSnapshot: createContextSnapshot({
            contextTokens: 88_000,
            lastCompletionTokens: 0,
            sessionPromptTokens: 0,
            sessionCompletionTokens: 0,
            scope: "provider-request",
            precision: "provider-exact",
            limit: { source: "unknown" },
            observedAt: 0,
          }),
        },
      },
    );

    primeCompactionSnapshot(session);
    // Simulate a slow pre-compaction autosave. Compaction captures a newer
    // snapshot while this write is blocked and must queue behind it.
    const staleSave = session.persistNow();
    await firstStarted;
    const compactSave = session.compact(undefined, 2);
    await Promise.resolve();
    releaseFirst();
    await Promise.all([staleSave, compactSave]);

    expect(maxActiveWrites).toBe(1);
    expect(saved).toHaveLength(2);
    const revisions = saved.map((entry) => entry.options?.revision ?? 0);
    const generations = saved.map(
      (entry) => entry.options?.writerGeneration ?? "",
    );
    expect(revisions).toEqual([1, 2]);
    expect(generations[0]).not.toBe("");
    expect(generations[1]).toBe(generations[0]);
    expect(saved[0]?.options?.contextUsage?.contextTokens).toBe(88_000);
    // The compaction snapshot stays on the request scale it started from: it may
    // only shrink by what the transcript shrank, never collapse to a
    // history-only figure that omits the system prefix and tool schemas.
    const compactedTokens = saved[1]?.options?.contextUsage?.contextTokens ?? 0;
    expect(compactedTokens).toBeLessThanOrEqual(88_000);
    expect(compactedTokens).toBeGreaterThan(80_000);
    expect(saved[1]?.options?.transcript?.map((item) => item.kind)).toEqual([
      "compacted",
    ]);
    expect(
      saved[1]?.messages.some(
        (message) =>
          message.role === "system" &&
          message.content.includes("Session memory from compacted earlier turns"),
      ),
    ).toBe(true);
  });

  it("gives a later resume a writer generation older processes cannot overtake", async () => {
    const identitiesA: Array<{ generation: string; revision: number }> = [];
    const identitiesB: Array<{ generation: string; revision: number }> = [];
    const persistence = (
      target: Array<{ generation: string; revision: number }>,
    ): PersistencePort => ({
      async saveSession(_messages, options) {
        target.push({
          generation: options?.writerGeneration ?? "",
          revision: options?.revision ?? 0,
        });
      },
      async loadPlan() {
        return undefined;
      },
      async savePlan() {},
      async deletePlan() {},
    });

    const older = new SessionController({
      agent: fakeAgent(),
      persistence: persistence(identitiesA),
      emit: () => {},
      sessionId: "shared-session",
    });
    older.loadHistory([{ role: "user", content: "shared" }], {
      sessionId: "shared-session",
      persistenceRevision: 7,
    });
    const newer = new SessionController({
      agent: fakeAgent(),
      persistence: persistence(identitiesB),
      emit: () => {},
      sessionId: "shared-session",
    });
    newer.loadHistory([{ role: "user", content: "shared" }], {
      sessionId: "shared-session",
      persistenceRevision: 7,
    });

    await older.persistNow();
    await newer.persistNow();
    // The old process saves again during a later shutdown.
    await older.persistNow();

    expect(identitiesA.map((identity) => identity.revision)).toEqual([1, 2]);
    expect(identitiesB.map((identity) => identity.revision)).toEqual([1]);
    expect(identitiesB[0]!.generation.localeCompare(identitiesA[0]!.generation)).toBeGreaterThan(0);
    expect(identitiesA[1]!.generation).toBe(identitiesA[0]!.generation);
  });

  it("persists an in-flight checkpoint and restores recovery orientation", async () => {
    const snapshots: SaveSessionOptions[] = [];
    let release!: () => void;
    const first = new SessionController({
      agent: {
        async runTurn(_request, handlers) {
          handlers.onMessages?.([{ role: "user", content: "continue the audit" }]);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return createTurnOutcome({
            status: "succeeded",
            answer: "done",
            steps: 1,
            remainingCriteria: [],
          });
        },
      },
      persistence: {
        ...fakePersistence(),
        async saveSession(_messages, options) {
          snapshots.push({ ...options });
        },
      },
      emit: () => {},
      sessionId: "restart-source",
    });

    const pending = first.submit("continue the audit");
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0));
    const interrupted = snapshots.at(-1)?.previousTurn;
    expect(interrupted).toMatchObject({
      status: "error",
      reason: expect.stringContaining("before the turn settled"),
    });

    first.loadHistory([{ role: "user", content: "different session" }], {
      sessionId: "restart-destination",
    });
    await first.persistNow();
    expect(snapshots.at(-1)?.previousTurn).toBeNull();

    let resumedRequest: Parameters<AgentPort["runTurn"]>[0] | undefined;
    const resumed = new SessionController({
      agent: {
        async runTurn(request) {
          resumedRequest = request;
          return createTurnOutcome({
            status: "succeeded",
            answer: "continued",
            steps: 1,
            remainingCriteria: [],
          });
        },
      },
      persistence: fakePersistence(),
      emit: () => {},
      sessionId: "restart-source",
    });
    resumed.loadHistory([{ role: "user", content: "continue the audit" }], {
      sessionId: "restart-source",
      previousTurn: interrupted ?? undefined,
    });
    await resumed.submit("keep going");

    expect(resumedRequest?.previousTurn).toEqual(interrupted);

    release();
    await pending;
    expect(snapshots.at(-1)?.previousTurn).toBeNull();
  });
});
