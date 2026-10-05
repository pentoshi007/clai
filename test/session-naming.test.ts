import { describe, expect, it } from "vitest";
import { DEFAULT_NAMING_MODEL, DEFAULT_NAMING_PROVIDER, resolveNamingRoute, SessionNamer } from "../src/app/controllers/session-naming.js";
import type { ChatMessage } from "../src/types.js";
import type { NamingPromptWindow } from "../src/store/session-prompts.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const requestText = (messages: ChatMessage[]) => messages[1]!.content;

function makeNamer() {
  const calls: ChatMessage[][] = [];
  const titles: string[] = [];
  const state = {
    fail: false, enabled: true,
    response: "SUMMARY: user is fixing the router bug\nTITLE: Fix the router bug",
    window: { count: 0, prompts: [] } as NamingPromptWindow,
  };
  const namer = new SessionNamer({
    complete: async (messages) => {
      calls.push(messages);
      if (state.fail) throw new Error("provider down");
      return state.response;
    },
    applyTitle: (title) => titles.push(title),
    enabled: () => state.enabled,
    prompts: async () => state.window,
  });
  const submit = (text: string) => {
    state.window = {
      count: state.window.count + 1,
      prompts: [...state.window.prompts, { number: state.window.count + 1, preview: text }],
    };
    namer.noteUserPrompt(true);
  };
  return { namer, calls, titles, state, submit };
}

describe("SessionNamer", () => {
  it("names on each new user prompt without waiting for assistant replies", async () => {
    const { submit, calls, titles } = makeNamer();
    submit("fix the router bug");
    await flush();
    expect(calls).toHaveLength(1);
    expect(titles).toEqual(["Fix the router bug"]);
    submit("add regression tests");
    await flush();
    submit("research prompt caching");
    await flush();
    expect(calls).toHaveLength(3);
    expect(requestText(calls[2]!)).toContain("research prompt caching");
    expect(titles).toEqual(["Fix the router bug"]);
  });

  it("ignores automatic requests and does not repeat naming for an unchanged prompt count", async () => {
    const { namer, calls, submit } = makeNamer();
    namer.noteUserPrompt(false);
    namer.maybeRename();
    await flush();
    expect(calls).toHaveLength(0);
    submit("real user request");
    await flush();
    namer.maybeRename();
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("carries earlier user task themes, summary, and title into subsequent names", async () => {
    const { calls, submit } = makeNamer();
    submit("fix the router bug");
    await flush();
    submit("research compaction");
    await flush();
    const text = requestText(calls[1]!);
    expect(text).toContain("fix the router bug");
    expect(text).toContain("research compaction");
    expect(text).toContain("Previous title: Fix the router bug");
    expect(text).toContain("Previous summary: user is fixing the router bug");
    expect(calls[1]![0]!.content).toContain("not just the latest task");
    expect(calls[1]![0]!.content).toContain("Only user prompts are supplied");
    expect(text).not.toContain("Assistant context");
  });

  it("uses bounded prompt excerpts supplied by persistent storage", async () => {
    const { namer, state, calls } = makeNamer();
    state.window = {
      count: 50000,
      prompts: Array.from({ length: 16 }, (_, index) => ({
        number: index === 15 ? 50000 : index + 1,
        preview: `Task-${index}: ${"details ".repeat(60)}`,
      })),
    };
    namer.noteUserPrompt(true);
    await flush();
    const text = requestText(calls[0]!);
    expect(text).toContain("Session user prompts: 50000");
    expect(text).toContain("Prompt 50000:");
    expect(text).toContain("Task-0:");
    expect(text).toContain("Task-15:");
    expect(text.length).toBeLessThan(4300);
  });

  it.each(["reset", "restore", "manual", "disabled"] as const)("ignores an old naming response after %s", async (action) => {
    const titles: string[] = [];
    let release!: (value: string) => void;
    let enabled = true;
    const namer = new SessionNamer({
      complete: () => new Promise<string>((resolve) => { release = resolve; }),
      applyTitle: (title) => titles.push(title), enabled: () => enabled,
      prompts: async () => ({ count: 1, prompts: [{ number: 1, preview: "Old task" }] }),
    });
    namer.noteUserPrompt(true);
    await flush();
    if (action === "manual") namer.markManual();
    else if (action === "disabled") enabled = false;
    else if (action === "restore") namer.restore("Another session");
    else namer.reset();
    release("SUMMARY: old task\nTITLE: Old session title");
    await flush();
    expect(titles).toEqual([]);
  });

  it("keeps the prior title on failure or invalid output and retries on the next prompt", async () => {
    const { submit, calls, titles, state } = makeNamer();
    state.fail = true;
    submit("fix the router bug");
    await flush();
    expect(titles).toHaveLength(0);
    state.fail = false;
    state.response = "no title supplied";
    submit("try again");
    await flush();
    expect(titles).toHaveLength(0);
    state.response = 'SUMMARY: s\nTITLE: "Fix the router bug."';
    submit("add tests");
    await flush();
    expect(calls).toHaveLength(3);
    expect(titles).toEqual(["Fix the router bug"]);
  });

  it("coalesces newer prompts while busy and suppresses a title from a stale prompt window", async () => {
    const releases: Array<(value: string) => void> = [];
    const calls: ChatMessage[][] = [];
    const titles: string[] = [];
    let text = "First task";
    const namer = new SessionNamer({
      prompts: async () => ({ count: 1, prompts: [{ number: 1, preview: text }] }),
      complete: (messages) => {
        calls.push(messages);
        return new Promise<string>((resolve) => releases.push(resolve));
      },
      applyTitle: (title) => titles.push(title), enabled: () => true,
    });
    namer.noteUserPrompt(true);
    await flush();
    text = "Latest task";
    namer.noteUserPrompt(true);
    namer.noteUserPrompt(true);
    expect(calls).toHaveLength(1);
    releases[0]!("SUMMARY: First task\nTITLE: First task");
    await flush();
    expect(titles).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(requestText(calls[1]!)).toContain("Latest task");
    releases[1]!("TITLE: Latest task");
    await flush();
    expect(titles).toEqual(["Latest task"]);
  });

  it("does not let an old request release a newer session's naming lock", async () => {
    const releases: Array<(value: string) => void> = [];
    const titles: string[] = [];
    const namer = new SessionNamer({
      prompts: async () => ({ count: 1, prompts: [{ number: 1, preview: "task" }] }),
      complete: () => new Promise<string>((resolve) => releases.push(resolve)),
      applyTitle: (title) => titles.push(title), enabled: () => true,
    });
    namer.noteUserPrompt(true);
    await flush();
    namer.restore("Loaded title");
    namer.noteUserPrompt(true);
    await flush();
    releases[0]!("TITLE: Old task");
    await flush();
    namer.maybeRename();
    expect(releases).toHaveLength(2);
    releases[1]!("TITLE: New task");
    await flush();
    expect(titles).toEqual(["New task"]);
  });

  it("skips naming after a manual title or when history is disabled", async () => {
    const manual = makeNamer();
    manual.namer.markManual();
    manual.submit("new task");
    const disabled = makeNamer();
    disabled.state.enabled = false;
    disabled.submit("new task");
    await flush();
    expect(manual.calls).toHaveLength(0);
    expect(disabled.calls).toHaveLength(0);
  });

  it("handles a storage failure without attempting an auxiliary request", async () => {
    let calls = 0;
    const namer = new SessionNamer({
      prompts: async () => { throw new Error("unavailable storage"); },
      complete: async () => { calls++; return "TITLE: Ignored"; },
      applyTitle: () => undefined, enabled: () => true,
    });
    namer.noteUserPrompt(true);
    await flush();
    expect(calls).toBe(0);
  });
});

describe("resolveNamingRoute", () => {
  const base = { defaultProvider: "free" as const };
  const defaults = { provider: DEFAULT_NAMING_PROVIDER, model: DEFAULT_NAMING_MODEL };

  it("uses the configured naming route", () => {
    expect(resolveNamingRoute({ provider: "codex", model: "main" }, {
      ...base, namingProvider: "openai", namingModel: "gpt-4o-mini",
    })).toEqual({ provider: "openai", model: "gpt-4o-mini" });
  });

  it("uses an independent default rather than the main route", () => {
    expect(resolveNamingRoute({ provider: "free", model: "free-1/mimo-v2.5-free" }, base)).toEqual(defaults);
    expect(resolveNamingRoute({ provider: "bynara", model: "qwen3.8" }, { defaultProvider: "bynara" })).toEqual(defaults);
  });

  it("honors a lone naming model on the default naming provider", () => {
    expect(resolveNamingRoute({}, { ...base, namingModel: "free-2/stepfun/step-3.7-flash:free" })).toEqual({
      provider: "free", model: "free-2/stepfun/step-3.7-flash:free",
    });
  });

  it("ignores an unknown naming provider", () => {
    expect(resolveNamingRoute({}, { ...base, namingProvider: "no-such-provider" as never })).toEqual(defaults);
  });

  it("resolves a configured naming provider's default model", () => {
    const result = resolveNamingRoute({}, { ...base, namingProvider: "openai" });
    expect(result.provider).toBe("openai");
    expect(typeof result.model).toBe("string");
  });
});
