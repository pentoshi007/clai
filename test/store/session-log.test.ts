import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { copyFile, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../../src/app/ports/transcript-item.js";
import type { ChatMessage } from "../../src/types.js";
import { useIsolatedHistory } from "../fixtures/isolated-history.js";

const fsMode = vi.hoisted(() => ({ windowsAppendHandles: false, opened: [] as Array<{ path: string; flags: string }> }));
vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  const { withWindowsAppendHandles } = await import("../fixtures/windows-append-handles.js");
  const windows = withWindowsAppendHandles(actual);
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      fsMode.opened.push({ path: String(args[0]), flags: String(args[1] ?? "r") });
      return (fsMode.windowsAppendHandles ? windows.open : actual.open)(...args);
    },
  };
});

const { dir } = useIsolatedHistory("clai-session-log-");

const item = (id: string, text: string): TranscriptItem => ({ kind: "assistant", id, text, done: true });
const user = (content: string): ChatMessage => ({ role: "user", content });

async function seeded(turns: number) {
  const history = await import("../../src/store/history.js");
  const messages: ChatMessage[] = [];
  const transcript: TranscriptItem[] = [];
  for (let index = 0; index < turns; index += 1) {
    messages.push(user(`turn ${index}`));
    transcript.push(item(`item-${index}`, `answer ${index}`));
    await history.upsertSession("logged", [...messages], "logged", [...transcript], undefined, index + 1, "0001-writer");
  }
  return { history, messages, transcript, path: history.getSessionLogPath("logged") };
}

describe("session log durability", () => {
  it("keeps the previous state for a frame torn at any byte and repairs it on the next save", async () => {
    const { history, path } = await seeded(3);
    const intact = readFileSync(path);
    const lastStart = intact.subarray(0, intact.length - 1).lastIndexOf(0x0a) + 1;
    for (let cut = lastStart; cut < intact.length; cut += Math.max(1, Math.floor((intact.length - lastStart) / 40))) {
      writeFileSync(path, intact.subarray(0, cut));
      vi.resetModules();
      const reloaded = await import("../../src/store/history.js");
      const restored = await reloaded.getSession("logged");
      expect(restored?.messages.map((message) => message.content), `cut at ${cut}`).toEqual(["turn 0", "turn 1"]);
    }
    writeFileSync(path, intact.subarray(0, intact.length - 7));
    vi.resetModules();
    const repaired = await import("../../src/store/history.js");
    await repaired.upsertSession("logged", [user("turn 0"), user("turn 1"), user("turn 2"), user("turn 3")], "logged", [item("item-0", "answer 0"), item("item-3", "answer 3")], undefined, 9, "0001-writer");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.every((line) => JSON.parse(line).v === 1)).toBe(true);
    expect((await repaired.getSession("logged"))?.messages.at(-1)?.content).toBe("turn 3");
    expect(history).toBeDefined();
  });

  it("recovers from a crash during a rewrite without losing the newest state", async () => {
    const { path } = await seeded(2);
    const orphan = `${path}.4242.deadbeef.tmp`;
    await copyFile(path, orphan);
    vi.resetModules();
    let history = await import("../../src/store/history.js");
    expect((await history.getSession("logged"))?.messages).toHaveLength(2);
    await history.upsertSession("logged", [user("turn 0"), user("turn 1"), user("turn 2")], "logged", [item("item-0", "answer 0"), item("item-1", "answer 1"), item("item-2", "answer 2")], undefined, 5, "0001-writer");
    expect(existsSync(orphan)).toBe(false);
    expect((await history.getSession("logged"))?.messages).toHaveLength(3);

    await copyFile(path, orphan);
    await truncate(path, 0);
    const { rm } = await import("node:fs/promises");
    await rm(path);
    vi.resetModules();
    history = await import("../../src/store/history.js");
    expect((await history.getSession("logged"))?.messages).toHaveLength(3);
    await history.upsertSession("logged", [user("turn 0"), user("turn 1"), user("turn 2"), user("turn 3")], "logged", [item("item-0", "answer 0"), item("item-3", "answer 3")], undefined, 6, "0001-writer");
    const restored = await history.getSession("logged");
    expect(restored?.messages).toHaveLength(4);
    expect(restored?.transcript?.map((entry) => entry.id)).toEqual(["item-0", "item-1", "item-2", "item-3"]);
    expect(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps complete frames it cannot replay in a side file before repairing the log", async () => {
    const { path } = await seeded(2);
    const future = `${JSON.stringify({ v: 2, t: "delta", seq: 2, summary: { id: "logged" }, written: "by a newer build" })}\n`;
    writeFileSync(path, readFileSync(path, "utf8") + future + "{\"v\":1,\"t\":\"del");
    vi.resetModules();
    const history = await import("../../src/store/history.js");
    await history.upsertSession("logged", [user("turn 0"), user("turn 1"), user("turn 2")], "logged", [item("item-0", "answer 0"), item("item-1", "answer 1"), item("item-2", "answer 2")], undefined, 9, "0001-writer");
    const kept = readdirSync(dirname(path)).filter((name) => name.includes(".rejected-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dirname(path), kept[0]!), "utf8")).toBe(future + "{\"v\":1,\"t\":\"del");
    expect(readFileSync(path, "utf8")).not.toContain("by a newer build");
    expect((await history.getSession("logged"))?.messages).toHaveLength(3);
  });

  it("drops a torn trailing fragment without keeping a side file", async () => {
    const { path } = await seeded(2);
    writeFileSync(path, readFileSync(path, "utf8") + "{\"v\":1,\"t\":\"delta\",\"seq\":2");
    vi.resetModules();
    const history = await import("../../src/store/history.js");
    await history.upsertSession("logged", [user("turn 0"), user("turn 1"), user("turn 2")], "logged", [item("item-0", "answer 0")], undefined, 9, "0001-writer");
    expect(readdirSync(dirname(path)).filter((name) => name.includes(".rejected-"))).toEqual([]);
    expect((await history.getSession("logged"))?.messages).toHaveLength(3);
  });

  it("does not re-read the log on every save of a session without transcript items", async () => {
    const history = await import("../../src/store/history.js");
    const messages: ChatMessage[] = [user("only messages")];
    await history.upsertSession("messages-only", [...messages], "messages-only", undefined, undefined, 1, "0001-writer");
    const path = history.getSessionLogPath("messages-only");
    fsMode.opened.length = 0;
    for (let revision = 2; revision <= 12; revision += 1) {
      messages.push({ role: "assistant", content: `reply ${revision}` });
      await history.upsertSession("messages-only", [...messages], "messages-only", undefined, undefined, revision, "0001-writer");
    }
    expect(fsMode.opened.filter((entry) => entry.path === path && entry.flags === "r")).toEqual([]);
    const restored = await history.getSession("messages-only");
    expect(restored?.messages).toHaveLength(12);
    expect(restored?.transcript).toBeUndefined();
  });

  it("sets an unreadable log aside instead of appending to it", async () => {
    const { path } = await seeded(1);
    writeFileSync(path, "garbage that is not a frame\n");
    vi.resetModules();
    const history = await import("../../src/store/history.js");
    await history.upsertSession("logged", [user("fresh")], "logged", [item("fresh", "fresh")], undefined, 1, "0002-writer");
    expect((await history.getSession("logged"))?.messages.map((message) => message.content)).toEqual(["fresh"]);
    const kept = readdirSync(dirname(path)).filter((name) => name.includes(".unreadable-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(dirname(path), kept[0]!), "utf8")).toContain("garbage");
  });

  it("works through Windows append-handle restrictions", async () => {
    fsMode.windowsAppendHandles = true;
    try {
      const { history, path } = await seeded(3);
      writeFileSync(path, readFileSync(path).subarray(0, statSync(path).size - 3));
      vi.resetModules();
      const reloaded = await import("../../src/store/history.js");
      for (let revision = 10; revision < 80; revision += 1) {
        await reloaded.upsertSession("logged", [user("turn 0"), user(`revision ${revision}`)], "logged", [item("item-0", "answer 0"), item("item-1", "answer 1")], undefined, revision, "0001-writer");
      }
      expect((await reloaded.getSession("logged"))?.messages.at(-1)?.content).toBe("revision 79");
      expect(readFileSync(path, "utf8").split("\n").filter(Boolean).length).toBeLessThanOrEqual(65);
      expect(history).toBeDefined();
    } finally {
      fsMode.windowsAppendHandles = false;
    }
  });

  it("saves another session while one session's lock is held, and never waits on the legacy lock", async () => {
    const history = await import("../../src/store/history.js");
    const { acquireStorageWriteLock, acquireJsonlWriteLock } = await import("../../src/store/history/jsonl-lock.js");
    const { sessionLockPath } = await import("../../src/store/history/session-paths.js");
    await history.upsertSession("held", [user("held")]);
    const releaseSession = await acquireStorageWriteLock(sessionLockPath("held"), "session history");
    const releaseLegacy = await acquireJsonlWriteLock();
    try {
      const started = Date.now();
      await history.upsertSession("free", [user("free")]);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect((await history.getSession("free"))?.messages[0]?.content).toBe("free");
      expect((await history.listSessionSummaries(10)).map((summary) => summary.id).sort()).toEqual(["free", "held"]);
    } finally {
      await releaseSession();
      await releaseLegacy();
    }
  });

  it("persists a message edited in place between saves", async () => {
    const history = await import("../../src/store/history.js");
    const messages: ChatMessage[] = [user("first"), { role: "assistant", content: "draft" }];
    const transcript = [item("a", "draft")];
    await history.upsertSession("edited", messages, "edited", transcript, undefined, 1, "0001-writer");
    (messages[1] as { content: string }).content = "final";
    messages.push(user("next"));
    await history.upsertSession("edited", messages, "edited", [item("a", "final"), item("b", "next")], undefined, 2, "0001-writer");
    vi.resetModules();
    const reloaded = await import("../../src/store/history.js");
    const restored = await reloaded.getSession("edited");
    expect(restored?.messages.map((message) => message.content)).toEqual(["first", "final", "next"]);
    expect(restored?.transcript?.map((entry) => (entry as { text: string }).text)).toEqual(["final", "next"]);
  });

  it("round-trips replayable provider state byte for byte across deltas and compaction", async () => {
    const history = await import("../../src/store/history.js");
    const { hydrateHistoryRecord } = await import("../../src/store/history/recovery.js");
    const image = join(dir(), "shot.png");
    writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const rich: ChatMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "look", images: [{ mediaType: "image/png", dataBase64: "AAAA", path: image }] },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "fs.read", args: { path: "/repo/a.ts", nested: { list: [1, "two", null] } }, rawArguments: "{\"path\":\"/repo/a.ts\"}" }],
        reasoningArtifacts: [{
          version: 1,
          kind: "encrypted",
          raw: { type: "reasoning", encrypted_content: "opaque-ciphertext" },
          provenance: { provider: "codex", model: "gpt-5", dialect: "openai-compatible" },
          replay: { scope: "all-history", persistence: "all-turns" },
          position: { sequence: 0, placement: "assistant" },
          accounting: { byteLength: 17, estimatedTokens: 5 },
        }],
        responsesReplay: {
          provider: "codex",
          model: "gpt-5",
          items: [
            { type: "reasoning", id: "rs_1", encrypted_content: "opaque-ciphertext", summary: [] },
            { type: "function_call", call_id: "call-1", name: "fs.read", arguments: "{\"path\":\"/repo/a.ts\"}" },
          ],
        },
      },
      { role: "tool", toolCallId: "call-1", content: "export const a = 1;\n" },
    ];
    let messages = [...rich];
    const singleRecords: unknown[] = [];
    for (let turn = 0; turn < 70; turn += 1) {
      messages = turn === 40 ? [{ role: "user", content: "[memory] summary" }, ...messages.slice(-2)] : [...messages, user(`turn ${turn}`)];
      const canonical = await history.upsertSession("rich", messages, "rich", [item(`i-${turn}`, `t ${turn}`)], undefined, turn + 1, "0001-writer");
      singleRecords.push(hydrateHistoryRecord(JSON.parse(JSON.stringify(canonical))));
      const restored = await history.getSession("rich");
      expect(JSON.stringify(restored?.messages)).toBe(JSON.stringify((singleRecords.at(-1) as { messages: unknown }).messages));
    }
    vi.resetModules();
    const reloaded = await import("../../src/store/history.js");
    expect(JSON.stringify((await reloaded.getSession("rich"))?.messages)).toBe(JSON.stringify((singleRecords.at(-1) as { messages: unknown }).messages));
  });
});
