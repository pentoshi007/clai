import { describe, expect, it } from "vitest";
import { SessionNamer } from "../src/app/controllers/session-naming.js";
import { SessionController } from "../src/app/controllers/session-controller.js";
import { createTurnOutcome } from "../src/agent/turn-outcome.js";
import type { ChatMessage } from "../src/types.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function user(text: string): ChatMessage {
  return { role: "user", content: text };
}

function assistant(text: string): ChatMessage {
  return { role: "assistant", content: text };
}

function makeNamer() {
  const calls: ChatMessage[][] = [];
  const titles: string[] = [];
  const state = {
    fail: false,
    enabled: true,
    response:
      "SUMMARY: user is fixing the router bug\nTITLE: Fix the router bug",
  };
  const namer = new SessionNamer({
    complete: async (messages) => {
      calls.push(messages);
      if (state.fail) throw new Error("provider down");
      return state.response;
    },
    applyTitle: (title) => titles.push(title),
    enabled: () => state.enabled,
  });
  return { namer, calls, titles, state };
}

function requestText(messages: ChatMessage[]): string {
  return String(messages[1]?.content ?? "");
}

describe("SessionNamer", () => {
  it("does not name before the second user-sent prompt", async () => {
    const { namer, calls, titles } = makeNamer();
    namer.noteUserPrompt(true);
    namer.maybeRename([user("hello"), assistant("hi")]);
    await flush();
    expect(calls).toHaveLength(0);
    expect(titles).toHaveLength(0);
  });

  it("names the session after the second user-sent prompt", async () => {
    const { namer, calls, titles } = makeNamer();
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    await flush();
    expect(calls).toHaveLength(1);
    expect(titles).toEqual(["Fix the router bug"]);
  });

  it("ignores auto agent requests", async () => {
    const { namer, calls } = makeNamer();
    for (let i = 0; i < 5; i++) namer.noteUserPrompt(false);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("re-evaluates every third user prompt after the first naming", async () => {
    const { namer, calls } = makeNamer();
    const history = [user("fix the router bug"), assistant("done")];
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename(history);
    await flush();
    expect(calls).toHaveLength(1);
    namer.noteUserPrompt(true);
    namer.maybeRename(history);
    await flush();
    namer.noteUserPrompt(true);
    namer.maybeRename(history);
    await flush();
    expect(calls).toHaveLength(1);
    namer.noteUserPrompt(true);
    history.push(user("now add tests for it"), assistant("tests added"));
    namer.maybeRename(history);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("carries the previous summary and title into the next naming request", async () => {
    const { namer, calls } = makeNamer();
    const history = [user("fix the router bug"), assistant("done")];
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename(history);
    await flush();
    for (let i = 0; i < 3; i++) namer.noteUserPrompt(true);
    namer.maybeRename([
      ...history,
      user("now add tests"),
      assistant("tests added"),
    ]);
    await flush();
    expect(calls).toHaveLength(2);
    const text = requestText(calls[1]!);
    expect(text).toContain("Previous title: Fix the router bug");
    expect(text).toContain(
      "Previous summary: user is fixing the router bug",
    );
  });

  it("sends only new messages after the first naming", async () => {
    const { namer, calls } = makeNamer();
    const history = [user("first question"), assistant("first answer")];
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename(history);
    await flush();
    for (let i = 0; i < 3; i++) namer.noteUserPrompt(true);
    namer.maybeRename([
      ...history,
      user("second question"),
      assistant("second answer"),
    ]);
    await flush();
    const text = requestText(calls[1]!);
    expect(text).toContain("second question");
    expect(text).not.toContain("first question");
  });

  it("keeps the previous title when the naming request fails and retries after one more prompt", async () => {
    const { namer, calls, titles, state } = makeNamer();
    state.fail = true;
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    await flush();
    expect(calls).toHaveLength(1);
    expect(titles).toHaveLength(0);
    state.fail = false;
    namer.noteUserPrompt(true);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    await flush();
    expect(calls).toHaveLength(2);
    expect(titles).toEqual(["Fix the router bug"]);
  });

  it("stops auto-naming after a manual name", async () => {
    const { namer, calls } = makeNamer();
    namer.markManual();
    for (let i = 0; i < 3; i++) namer.noteUserPrompt(true);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("reset restarts the cadence", async () => {
    const { namer, calls } = makeNamer();
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    await flush();
    expect(calls).toHaveLength(1);
    namer.reset();
    namer.noteUserPrompt(true);
    namer.maybeRename([user("new topic"), assistant("ok")]);
    await flush();
    expect(calls).toHaveLength(1);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("new topic"), assistant("ok")]);
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("restore keeps the loaded title and restarts the cadence", async () => {
    const { namer, calls } = makeNamer();
    namer.restore("Loaded title");
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("continue the work"), assistant("ok")]);
    await flush();
    expect(calls).toHaveLength(1);
    expect(requestText(calls[0]!)).toContain("Previous title: Loaded title");
  });

  it("sanitizes model output", async () => {
    const { namer, titles, state } = makeNamer();
    state.response = 'SUMMARY: s\nTITLE: "Fix the router bug."';
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    await flush();
    expect(titles).toEqual(["Fix the router bug"]);
  });

  it("does not run two naming requests concurrently", async () => {
    const calls: ChatMessage[][] = [];
    const titles: string[] = [];
    let release: (() => void) | undefined;
    const namer = new SessionNamer({
      complete: async (messages) => {
        calls.push(messages);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return "SUMMARY: s\nTITLE: Fix the router bug";
      },
      applyTitle: (title) => titles.push(title),
      enabled: () => true,
    });
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    await flush();
    expect(calls).toHaveLength(1);
    release!();
    await flush();
    expect(titles).toEqual(["Fix the router bug"]);
  });

  it("skips naming when disabled", async () => {
    const { namer, calls, state } = makeNamer();
    state.enabled = false;
    for (let i = 0; i < 3; i++) namer.noteUserPrompt(true);
    namer.maybeRename([user("fix the router bug"), assistant("done")]);
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("skips internal and tool messages in the transcript", async () => {
    const { namer, calls } = makeNamer();
    const history: ChatMessage[] = [
      user("real question"),
      {
        role: "tool",
        content: "tool output",
        toolCallId: "call_1",
        name: "fs.read",
      } as ChatMessage,
      { role: "user", content: "internal note", internal: true } as ChatMessage,
      assistant("real answer"),
    ];
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename(history);
    await flush();
    const text = requestText(calls[0]!);
    expect(text).toContain("real question");
    expect(text).toContain("real answer");
    expect(text).not.toContain("tool output");
    expect(text).not.toContain("internal note");
  });
});

describe("session controller naming wiring", () => {
  function makeSession(namingCalls: ChatMessage[][], savedNames: unknown[]) {
    return new SessionController({
      agent: {
        async runTurn() {
          return createTurnOutcome({
            status: "succeeded",
            answer: "ok",
            steps: 1,
            remainingCriteria: [],
          });
        },
      },
      persistence: {
        async saveSession(_messages: readonly ChatMessage[], options?: { name?: string | undefined }) {
          savedNames.push(options?.name);
        },
        async loadPlan() {
          return undefined;
        },
        async savePlan() {},
        async deletePlan() {},
      },
      emit: () => undefined,
      sessionId: `naming-test-${Math.random().toString(36).slice(2, 8)}`,
      titleCompleter: async (messages) => {
        namingCalls.push(messages);
        return "SUMMARY: user is fixing the router bug\nTITLE: Fix the router bug";
      },
    });
  }

  it("names the session after the second user prompt and persists the generated title", async () => {
    const namingCalls: ChatMessage[][] = [];
    const savedNames: unknown[] = [];
    const session = makeSession(namingCalls, savedNames);
    (session as unknown as { history: ChatMessage[] }).history = [
      user("fix the router bug"),
      assistant("done"),
    ];
    await session.submit("first prompt");
    await flush();
    expect(namingCalls).toHaveLength(0);
    await session.submit("second prompt");
    await flush();
    await flush();
    expect(namingCalls).toHaveLength(1);
    expect(session.getState().title).toBe("Fix the router bug");
    expect(savedNames).toContain("Fix the router bug");
    session.dispose();
  });

  it("does not count auto agent requests (displayPrompt null)", async () => {
    const namingCalls: ChatMessage[][] = [];
    const savedNames: unknown[] = [];
    const session = makeSession(namingCalls, savedNames);
    (session as unknown as { history: ChatMessage[] }).history = [
      user("fix the router bug"),
      assistant("done"),
    ];
    await session.submit("implement the plan", { displayPrompt: null });
    await session.submit("keep going", { displayPrompt: null });
    await flush();
    expect(namingCalls).toHaveLength(0);
    session.dispose();
  });
});
