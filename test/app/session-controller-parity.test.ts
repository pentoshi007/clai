import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentPort } from "../../src/app/ports/agent-port.js";
import type { PersistencePort } from "../../src/app/ports/persistence-port.js";
import { SessionController } from "../../src/app/controllers/session-controller.js";
import type { AnyAppEvent } from "../../src/app/events/app-event.js";

const completeWithProvider = vi.fn();
vi.mock("../../src/llm/router.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/llm/router.js")>();
  return {
    ...actual,
    completeWithProvider: (...args: unknown[]) => completeWithProvider(...args),
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
      return "y";
    },
  };
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
        return "";
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
    const events: AnyAppEvent[] = [];
    const session = new SessionController({
      agent: fakeAgent(),
      persistence: fakePersistence(),
      emit: (e) => events.push(e),
      sessionId: "sess-hist-compact",
      provider: "groq" as never,
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

    const result = await session.compact(visual, 2);
    expect(result.summarized).toBe(true);
    expect(completeWithProvider).toHaveBeenCalled();
    const prompt = String(completeWithProvider.mock.calls[0]?.[0]?.messages?.[1]?.content ?? "");
    expect(prompt).toContain("history prompt one");
    expect(prompt).toContain("follow-up after resume");
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
    expect(events.some((e) => e.type === "compacted")).toBe(true);
  });
});
