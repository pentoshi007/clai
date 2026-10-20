import { spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptItem } from "../../src/app/ports/transcript-item.js";
import type { HistoryRecord } from "../../src/store/history/recovery.js";
import { useIsolatedHistory } from "../fixtures/isolated-history.js";

const { dir } = useIsolatedHistory("clai-session-migration-");

const item = (id: string, text = id): TranscriptItem => ({ kind: "assistant", id, text, done: true });

function legacy(id: string, revision: number, extra: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id,
    name: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + revision * 60_000).toISOString(),
    cwd: "/repo",
    revision,
    writerGeneration: "0001-legacy",
    messages: [{ role: "user", content: `${id} r${revision}` }],
    transcript: [item(`${id}-r${revision}`)],
    ...extra,
  };
}

function writeLegacy(lines: readonly (HistoryRecord | string)[]): string {
  const path = join(dir(), "history.jsonl");
  writeFileSync(path, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n", { mode: 0o600 });
  return path;
}

async function reload() {
  vi.resetModules();
  return await import("../../src/store/history.js");
}

describe("legacy history migration", () => {
  it("imports a clean legacy file once, newest revision first, without writing to history.jsonl", async () => {
    const path = writeLegacy([
      legacy("alpha", 1),
      legacy("beta", 1, { messages: [{ role: "user", content: "日本語 🧪" }] }),
      legacy("alpha", 2),
      legacy("alpha", 3),
    ]);
    const before = readFileSync(path);
    const history = await reload();
    expect((await history.listSessionSummaries(10, { recovery: "blocking" })).map((summary) => summary.id).sort()).toEqual(["alpha", "beta"]);
    expect((await history.getSession("alpha"))?.messages[0]?.content).toBe("alpha r3");
    expect((await history.getSession("beta"))?.messages[0]?.content).toBe("日本語 🧪");
    expect(readFileSync(path).equals(before)).toBe(true);

    const logStamp = statSync(history.getSessionLogPath("alpha")).mtimeMs;
    const again = await reload();
    await again.listSessionSummaries(10, { recovery: "blocking" });
    await again.getSession("alpha");
    expect(statSync(again.getSessionLogPath("alpha")).mtimeMs).toBe(logStamp);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it("imports past malformed lines and recovers sessions only found in an orphaned rewrite", async () => {
    const path = writeLegacy([legacy("alpha", 1), "{this is not json", legacy("beta", 1), legacy("alpha", 2)]);
    writeFileSync(`${path}.4242.cafebabe.tmp`, JSON.stringify(legacy("ghost", 1)) + "\n");
    const history = await reload();
    expect((await history.listSessionSummaries(10, { recovery: "blocking" })).map((summary) => summary.id).sort()).toEqual(["alpha", "beta", "ghost"]);
    expect((await history.getSession("alpha"))?.messages[0]?.content).toBe("alpha r2");
    expect((await history.getSession("ghost"))?.messages[0]?.content).toBe("ghost r1");
  });

  it("re-imports sessions that an older binary appended after the migration", async () => {
    const path = writeLegacy([legacy("alpha", 1)]);
    const history = await reload();
    expect((await history.getSession("alpha"))?.messages[0]?.content).toBe("alpha r1");
    writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify(legacy("alpha", 2)) + "\n" + JSON.stringify(legacy("late", 1)) + "\n");
    expect((await history.getSession("alpha"))?.messages[0]?.content).toBe("alpha r2");
    expect((await history.getSession("late"))?.messages[0]?.content).toBe("late r1");
  });

  it("keeps items from a stale legacy copy when the new store is fresher", async () => {
    writeLegacy([legacy("alpha", 1)]);
    const history = await reload();
    await history.upsertSession("alpha", [{ role: "user", content: "new store" }], "alpha", [item("alpha-r1"), item("new-item")], undefined, 5, "0002-current");
    const path = join(dir(), "history.jsonl");
    writeFileSync(path, readFileSync(path, "utf8") + JSON.stringify(legacy("alpha", 2, { transcript: [item("alpha-r1"), item("legacy-late")] })) + "\n");
    const restored = await history.getSession("alpha");
    expect(restored?.messages[0]?.content).toBe("new store");
    expect(restored?.transcript?.map((entry) => entry.id)).toEqual(expect.arrayContaining(["alpha-r1", "new-item", "legacy-late"]));
  });
});

describe("session lifecycle", () => {
  it("archives sessions beyond the retention limit and still resumes them", async () => {
    const { updateConfig } = await import("../../src/store/config.js");
    updateConfig({ historyRetentionLimit: 2 });
    const history = await reload();
    for (const [index, id] of ["oldest", "middle", "newest"].entries()) {
      await history.upsertSession(id, [{ role: "user", content: id }], id, [item(id)], undefined, 1, `000${index}-writer`);
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    expect((await history.listSessionSummaries(10)).map((summary) => summary.id).sort()).toEqual(["middle", "newest"]);
    expect(existsSync(history.getSessionLogPath("oldest"))).toBe(false);
    expect((await history.getSession("oldest"))?.messages[0]?.content).toBe("oldest");
  });

  it("removes the session directory and index entry on delete, purge and clear", async () => {
    const history = await reload();
    const { deleteSession, purgeSession, clearAllHistory } = await import("../../src/store/history/lifecycle.js");
    for (const id of ["one", "two", "three"]) await history.upsertSession(id, [{ role: "user", content: `remove-me ${id}` }]);
    const index = () => JSON.parse(readFileSync(join(history.getSessionsDir(), "index.json"), "utf8")).entries as Record<string, unknown>;
    expect(Object.keys(index()).sort()).toEqual(["one", "three", "two"]);

    expect((await deleteSession("one")).deleted).toBe(true);
    expect(existsSync(join(history.getSessionLogPath("one"), ".."))).toBe(false);
    expect(Object.keys(index())).not.toContain("one");
    expect(await history.getSession("one")).toBeUndefined();

    expect((await purgeSession("two")).deleted).toBe(true);
    expect(existsSync(join(history.getSessionLogPath("two"), ".."))).toBe(false);
    expect(await history.getSession("two")).toBeUndefined();

    await clearAllHistory();
    expect(existsSync(history.getSessionsDir())).toBe(false);
    expect(await history.getSession("three")).toBeUndefined();
    expect(await history.listSessionSummaries(10)).toEqual([]);
  });

  it("does not resurrect a deleted session from history.jsonl", async () => {
    writeLegacy([legacy("alpha", 1), legacy("beta", 1)]);
    const history = await reload();
    const { deleteSession } = await import("../../src/store/history/lifecycle.js");
    expect((await deleteSession("alpha")).deleted).toBe(true);
    const fresh = await reload();
    expect(await fresh.getSession("alpha")).toBeUndefined();
    expect((await fresh.listSessionSummaries(10, { recovery: "blocking" })).map((summary) => summary.id)).toEqual(["beta"]);
    expect(history).toBeDefined();
  });

  it("writes nothing in private mode", async () => {
    const { updateConfig } = await import("../../src/store/config.js");
    updateConfig({ privateMode: true });
    const history = await reload();
    await history.upsertSession("secret", [{ role: "user", content: "secret" }]);
    expect(existsSync(history.getSessionsDir())).toBe(false);
  });
});

describe("two writers on one session", () => {
  it("unions transcript items, keeps the newest messages and flags the merge", async () => {
    const script = (generation: string, revision: number, content: string, ids: string[]) => `
      const history = await import(${JSON.stringify(new URL("../../src/store/history.ts", import.meta.url).pathname)});
      await history.upsertSession("shared", [{ role: "user", content: ${JSON.stringify(content)} }], "shared",
        ${JSON.stringify(ids)}.map((id) => ({ kind: "assistant", id, text: id, done: true })), undefined, ${revision}, ${JSON.stringify(generation)});
    `;
    const run = (code: string) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: process.env, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
    };
    run(script("0001-writer-a", 1, "a1", ["first"]));
    run(script("0002-writer-b", 1, "b1", ["first", "from-b"]));
    run(script("0001-writer-a", 2, "a2 stale", ["first", "from-a"]));
    const history = await reload();
    const saved = await history.getSession("shared");
    expect(saved?.messages[0]?.content).toBe("b1");
    expect(saved?.transcript?.map((entry) => entry.id)).toEqual(expect.arrayContaining(["first", "from-a", "from-b"]));
    expect(saved?.pendingMerge).toBe(true);
  }, 30_000);
});

const root = process.platform !== "win32" && process.getuid?.() === 0;
const OWNER = 4243;
const fixture = vi.hoisted(() => ({ home: "" }));
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => args[0] === "/etc/passwd"
      ? `operator:x:${OWNER}:${OWNER}::${fixture.home}:/bin/sh\n`
      : actual.readFileSync(...args),
  };
});

describe.skipIf(!root)("session storage under sudo", () => {
  it("hands every session file and directory to the invoking user", async () => {
    const home = mkdtempSync(join(tmpdir(), "clai-session-sudo-"));
    try {
      chownSync(home, OWNER, OWNER);
      fixture.home = home;
      vi.stubEnv("SUDO_UID", String(OWNER));
      vi.stubEnv("SUDO_USER", "operator");
      vi.stubEnv("CLAI_HISTORY_DIR", join(home, ".clai"));
      const history = await reload();
      await history.upsertSession("sudo", [{ role: "user", content: "root" }]);
      await history.upsertSession("sudo", [{ role: "user", content: "root" }, { role: "assistant", content: "again" }]);
      const sessions = history.getSessionsDir();
      const walk = (path: string): string[] => [path, ...(statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => walk(join(path, name))) : [])];
      for (const path of walk(sessions)) {
        const info = statSync(path);
        expect(info.uid, path).toBe(OWNER);
        expect(info.mode & 0o777, path).toBe(info.isDirectory() ? 0o700 : 0o600);
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
