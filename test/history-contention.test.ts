import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

afterEach(() => vi.clearAllMocks());

describe("independent session storage", () => {
  it("writes and reads prompts while the history writer is busy", async () => {
    const { acquireJsonlWriteLock } = await import("../src/store/history/jsonl-lock.js");
    const { SessionPromptStore } = await import("../src/store/session-prompts.js");
    const release = await acquireJsonlWriteLock();
    const store = new SessionPromptStore("unblocked-prompts");
    const writing = store.append({ content: "retained while history is locked" });
    try {
      expect(await Promise.race([writing.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 250))])).toBe(true);
      expect(await store.count()).toBe(1);
      expect(await readFile(store.path, "utf8")).toContain("retained while history is locked");
    } finally {
      await release();
      await writing;
    }
  });

  it("does not steal an old lock from a living writer", async () => {
    const { acquireJsonlWriteLock, historyDirPath } = await import("../src/store/history/jsonl-lock.js");
    const release = await acquireJsonlWriteLock();
    const path = join(historyDirPath(), "history.jsonl.lock");
    const token = await readFile(path, "utf8");
    const old = new Date(Date.now() - 120_000);
    await utimes(path, old, old);
    const waiting = acquireJsonlWriteLock();
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(await readFile(path, "utf8")).toBe(token);
    } finally {
      await release();
      await (await waiting)();
    }
  });

  it("serves valid summaries without rescanning transcript payloads", async () => {
    const { upsertSession, listSessionSummaries, getSessionLogPath } = await import("../src/store/history.js");
    await upsertSession("indexed-fast-path", [{ role: "user", content: "x".repeat(100_000) }]);
    vi.mocked(fs.open).mockClear();
    const summaries = await listSessionSummaries(10, { recovery: "blocking" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(summaries.map((summary) => summary.id)).toEqual(["indexed-fast-path"]);
    const reads = vi.mocked(fs.open).mock.calls.filter(([path]) => path === getSessionLogPath("indexed-fast-path"));
    expect(reads).toHaveLength(0);
  });

  it("keeps late transcript items from an older writer without replacing current model history", async () => {
    const { upsertSession, getSession } = await import("../src/store/history.js");
    const first = { id: "retained-first", kind: "user" as const, text: "first", done: true };
    const late = { id: "retained-late", kind: "assistant" as const, text: "finished in minimized process", done: true };
    const newest = { id: "retained-new", kind: "user" as const, text: "new process", done: true };
    await upsertSession("two-writers", [{ role: "user", content: "first" }], undefined, [first], undefined, 1, "writer-a");
    await upsertSession("two-writers", [{ role: "user", content: "current context" }], undefined, [first, newest], undefined, 1, "writer-b");
    await upsertSession("two-writers", [{ role: "user", content: "stale context" }], undefined, [first, late], undefined, 2, "writer-a");
    const saved = await getSession("two-writers");
    expect(saved?.messages[0]?.content).toBe("current context");
    expect(saved?.transcript?.map((item) => item.id)).toEqual(expect.arrayContaining([first.id, late.id, newest.id]));
  });

  it("keeps an older writer's late items in a compacted session through the newer writer's later saves", async () => {
    const { upsertSession, getSession } = await import("../src/store/history.js");
    const shared = [
      { id: "c-first", kind: "user" as const, text: "first", done: true },
      { id: "c-summary", kind: "compacted" as const, summary: "memory", originalItems: [], done: true },
      { id: "c-after", kind: "user" as const, text: "after compaction", done: true },
    ];
    const late = { id: "c-late", kind: "assistant" as const, text: "finished in minimized sudo process", done: true };
    const resumed = { id: "c-resumed", kind: "user" as const, text: "resumed prompt", done: true };
    const answer = { id: "c-answer", kind: "assistant" as const, text: "resumed answer", done: true };
    await upsertSession("compacted-writers", [], undefined, shared, undefined, 10, "0001-writer-a");
    await upsertSession("compacted-writers", [{ role: "user", content: "current" }], undefined, [...shared, resumed], undefined, 1, "0002-writer-b");
    await upsertSession("compacted-writers", [{ role: "user", content: "stale" }], undefined, [...shared, late], undefined, 11, "0001-writer-a");
    expect((await getSession("compacted-writers"))?.transcript?.map((item) => item.id))
      .toEqual(["c-first", "c-summary", "c-after", "c-late", "c-resumed"]);
    await upsertSession("compacted-writers", [{ role: "user", content: "current" }], undefined, [...shared, resumed, answer], undefined, 2, "0002-writer-b");
    const saved = await getSession("compacted-writers");
    expect(saved?.messages[0]?.content).toBe("current");
    expect(saved?.transcript?.map((item) => item.id))
      .toEqual(["c-first", "c-summary", "c-after", "c-late", "c-resumed", "c-answer"]);
  });
});
