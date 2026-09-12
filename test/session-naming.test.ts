import { describe, expect, it } from "vitest";
import { SessionNamer } from "../src/app/controllers/session-naming.js";
import { SessionController } from "../src/app/controllers/session-controller.js";
import { createTurnOutcome } from "../src/agent/turn-outcome.js";
import type { ChatMessage } from "../src/types.js";
import type { TranscriptItem } from "../src/app/ports/transcript-item.js";

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

  it("keeps earlier tasks in every naming request instead of sending only the latest task", async () => {
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
    expect(text).toContain("first question");
    expect(calls[1]![0]!.content).toContain("not just the latest task");
    expect(calls[1]![0]!.content).toContain("earlier and newer work");
  });

  it("includes early, middle, and latest requests when the conversation exceeds the old tail window", async () => {
    const { namer, calls } = makeNamer();
    const history = Array.from({ length: 30 }, (_, index) => [
      user(`Task-${index}: ${"details ".repeat(100)}`),
      assistant("Long implementation output ".repeat(100)),
    ]).flat();
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename(history);
    await flush();
    const text = requestText(calls[0]!);
    for (let index = 0; index < 30; index++) expect(text).toContain(`Task-${index}:`);
    expect(text.length).toBeLessThan(4300);
  });

  it("retains tasks observed before naming when compaction replaces the history with an equal-length window", async () => {
    const { namer, calls } = makeNamer();
    namer.noteUserPrompt(true);
    namer.maybeRename([user("Implement authentication"), assistant("done")]);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("Improve billing"), assistant("done")]);
    await flush();
    expect(requestText(calls[0]!)).toContain("Implement authentication");
    expect(requestText(calls[0]!)).toContain("Improve billing");
    for (let index = 0; index < 3; index++) namer.noteUserPrompt(true);
    namer.maybeRename([user("Add deployment checks"), assistant("done")]);
    await flush();
    for (const task of ["Implement authentication", "Improve billing", "Add deployment checks"]) {
      expect(requestText(calls[1]!)).toContain(task);
    }
  });

  it("restores earlier tasks from nested compacted transcript items without exposing tool output or reasoning", async () => {
    const calls: ChatMessage[][] = [];
    const namer = new SessionNamer({
      complete: async (messages) => { calls.push(messages); return "TITLE: Authentication, Billing and Deployment"; },
      applyTitle: () => undefined,
      enabled: () => true,
      transcript: () => [{ kind: "compacted", id: "outer", done: true, summary: "Recent billing work", originalItems: [
        { kind: "compacted", id: "inner", done: true, summary: "Earlier work", originalItems: [
          { kind: "user", id: "first", done: true, text: "Implement authentication" },
          { kind: "thinking", id: "private", done: true, content: "Private reasoning" },
          { kind: "tool", id: "tool", name: "fs.read", argsDisplay: "", output: "Private tool output", status: "ok", done: true },
        ] },
        { kind: "user", id: "second", done: true, text: "Improve billing" },
      ] }],
    });
    namer.restore("Billing improvements");
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("Add deployment checks")]);
    await flush();
    const text = requestText(calls[0]!);
    for (const task of ["Implement authentication", "Improve billing", "Add deployment checks"]) expect(text).toContain(task);
    expect(text).not.toContain("Private reasoning");
    expect(text).not.toContain("Private tool output");
  });

  it.each(["reset", "restore", "manual", "disabled"] as const)("ignores an old naming response after %s", async (action) => {
    const titles: string[] = [];
    let release!: (value: string) => void;
    let enabled = true;
    const namer = new SessionNamer({
      complete: () => new Promise<string>((resolve) => { release = resolve; }),
      applyTitle: (title) => titles.push(title), enabled: () => enabled,
    });
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename([user("Old session task")]);
    if (action === "manual") namer.markManual();
    else if (action === "disabled") enabled = false;
    else if (action === "restore") namer.restore("Another session");
    else namer.reset();
    release("SUMMARY: old task\nTITLE: Old session title");
    await flush();
    expect(titles).toEqual([]);
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

  it("does not let an old request release the new session's naming lock", async () => {
    const releases: Array<(value: string) => void> = [];
    const titles: string[] = [];
    const namer = new SessionNamer({
      complete: () => new Promise<string>((resolve) => releases.push(resolve)),
      applyTitle: (title) => titles.push(title), enabled: () => true,
    });
    for (const topic of ["Old task", "New task"]) {
      namer.reset();
      namer.noteUserPrompt(true);
      namer.noteUserPrompt(true);
      namer.maybeRename([user(topic)]);
    }
    releases[0]!("TITLE: Old task");
    await flush();
    namer.maybeRename([user("New task")]);
    expect(releases).toHaveLength(2);
    releases[1]!("TITLE: New task");
    await flush();
    expect(titles).toEqual(["New task"]);
  });

  it("keeps an exceptionally long request overview bounded", async () => {
    const { namer, calls } = makeNamer();
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    namer.maybeRename(Array.from({ length: 3000 }, (_, index) => user(`Task ${index} ${"details".repeat(100)}`)));
    await flush();
    expect(requestText(calls[0]!).length).toBeLessThan(4300);
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
  function makeSession(namingCalls: ChatMessage[][], savedNames: unknown[], getTranscriptSnapshot?: () => TranscriptItem[]) {
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
      getTranscriptSnapshot,
      sessionId: `naming-test-${Math.random().toString(36).slice(2, 8)}`,
      titleCompleter: async (messages) => {
        namingCalls.push(messages);
        return "SUMMARY: user is fixing the router bug\nTITLE: Fix the router bug";
      },
    });
  }

  it("uses the durable transcript rather than just the compacted model history", async () => {
    const namingCalls: ChatMessage[][] = [];
    const session = makeSession(namingCalls, [], () => [
      { kind: "user", id: "early", text: "Implement authentication", done: true },
    ]);
    try {
      session.loadHistory([user("Improve billing")], { title: "Billing" });
      await session.submit("first follow-up");
      await session.submit("second follow-up");
      await flush();
      expect(requestText(namingCalls[0]!)).toContain("Implement authentication");
      expect(requestText(namingCalls[0]!)).toContain("Improve billing");
    } finally {
      session.dispose();
    }
  });

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

describe("resolveNamingRoute", () => {
  const base = { defaultProvider: "free" as const };

  it("uses the configured naming route when set", async () => {
    const { resolveNamingRoute } = await import(
      "../src/app/controllers/session-naming.js"
    );
    expect(
      resolveNamingRoute(
        { provider: "free", model: "free-1/mimo-v2.5-free" },
        {
          ...base,
          namingProvider: "openai",
          namingModel: "gpt-4o-mini",
        },
      ),
    ).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("defaults to kilo-auto instead of the session route when unconfigured", async () => {
    const { resolveNamingRoute, DEFAULT_NAMING_PROVIDER, DEFAULT_NAMING_MODEL } =
      await import("../src/app/controllers/session-naming.js");
    expect(
      resolveNamingRoute(
        { provider: "free", model: "free-1/mimo-v2.5-free" },
        base,
      ),
    ).toEqual({ provider: DEFAULT_NAMING_PROVIDER, model: DEFAULT_NAMING_MODEL });
    expect(
      resolveNamingRoute(
        { provider: "bynara", model: "bynara/qwen3.8-27b" },
        { defaultProvider: "bynara" as const },
      ),
    ).toEqual({ provider: DEFAULT_NAMING_PROVIDER, model: DEFAULT_NAMING_MODEL });
  });

  it("honors a lone naming model on the default naming provider", async () => {
    const { resolveNamingRoute } = await import(
      "../src/app/controllers/session-naming.js"
    );
    const resolved = resolveNamingRoute(
      { provider: "bynara", model: "bynara/qwen3.8-27b" },
      {
        ...base,
        namingModel: "free-2/stepfun/step-3.7-flash:free",
      },
    );
    expect(resolved).toEqual({
      provider: "free",
      model: "free-2/stepfun/step-3.7-flash:free",
    });
  });

  it("ignores an unknown configured provider", async () => {
    const { resolveNamingRoute, DEFAULT_NAMING_PROVIDER, DEFAULT_NAMING_MODEL } =
      await import("../src/app/controllers/session-naming.js");
    const resolved = resolveNamingRoute(
      { provider: "free", model: "free-1/mimo-v2.5-free" },
      {
        ...base,
        namingProvider: "no-such-provider" as never,
      },
    );
    expect(resolved).toEqual({
      provider: DEFAULT_NAMING_PROVIDER,
      model: DEFAULT_NAMING_MODEL,
    });
  });

  it("resolves the naming provider default model when no naming model is set", async () => {
    const { resolveNamingRoute } = await import(
      "../src/app/controllers/session-naming.js"
    );
    const resolved = resolveNamingRoute(
      { provider: "free", model: "free-1/mimo-v2.5-free" },
      { ...base, namingProvider: "openai" },
    );
    expect(resolved.provider).toBe("openai");
    expect(typeof resolved.model).toBe("string");
  });
});
