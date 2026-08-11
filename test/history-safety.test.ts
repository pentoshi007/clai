import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Vitest setup pins CLAI_HISTORY_DIR separately from CLAI_DATA_DIR — override
// every data root like history-autosave.test.ts so we never touch real ~/.clai.
const dataEnvKeys = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
  "CLAI_CONFIG_DIR",
] as const;

let dataDir: string;
let originalEnv: Partial<
  Record<(typeof dataEnvKeys)[number], string | undefined>
>;

beforeEach(() => {
  originalEnv = {};
  for (const key of dataEnvKeys) originalEnv[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "clai-hist-safety-"));
  process.env.CLAI_DATA_DIR = dataDir;
  process.env.CLAI_HISTORY_DIR = dataDir;
  process.env.CLAI_CONFIG_DIR = dataDir;
  process.env.CLAI_PLAN_DIR = dataDir;
  process.env.CLAI_LOG_DIR = join(dataDir, "logs");
  process.env.CLAI_ARTIFACT_DIR = join(dataDir, "artifacts");
  process.env.CLAI_JOBS_DIR = join(dataDir, "jobs");
  mkdirSync(join(dataDir, "logs"), { recursive: true });
  vi.resetModules();
});

afterEach(async () => {
  for (const key of dataEnvKeys) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  vi.resetModules();
});

function sample(
  id: string,
  updatedAt: string,
  name = id,
  revision?: number,
): {
  id: string;
  revision?: number | undefined;
  name: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  messages: { role: string; content: string }[];
} {
  return {
    id,
    ...(revision ? { revision } : {}),
    name,
    createdAt: updatedAt,
    updatedAt,
    cwd: "/tmp",
    messages: [{ role: "user", content: name }],
  };
}

describe("history retention partitioning", () => {
  it("keeps newest by updatedAt and reports pruned without file-order tricks", async () => {
    const { partitionByRetention } = await import("../src/store/history.js");
    const records = [
      sample("old", "2020-01-01T00:00:00.000Z", "old"),
      sample("mid", "2021-01-01T00:00:00.000Z", "mid"),
      sample("new", "2022-01-01T00:00:00.000Z", "new"),
      // duplicate older version of "new" must lose
      sample("new", "2021-06-01T00:00:00.000Z", "new-stale"),
    ];
    const { kept, pruned } = partitionByRetention(records, 2);
    expect(kept.map((r) => r.id)).toEqual(["new", "mid"]);
    expect(pruned.map((r) => r.id)).toEqual(["old"]);
    expect(kept.find((r) => r.id === "new")?.name).toBe("new");
  });

  it("unlimited (0) keeps everything", async () => {
    const { partitionByRetention } = await import("../src/store/history.js");
    const records = [
      sample("a", "2020-01-01T00:00:00.000Z"),
      sample("b", "2021-01-01T00:00:00.000Z"),
    ];
    const { kept, pruned } = partitionByRetention(records, 0);
    expect(kept).toHaveLength(2);
    expect(pruned).toHaveLength(0);
  });

  it("prefers capture revision over a stale source with a newer timestamp", async () => {
    const { dedupeHistoryById } = await import("../src/store/history.js");
    const compacted = sample(
      "same-session",
      "2026-07-19T10:00:00.000Z",
      "compacted-new",
      9,
    );
    const stale = sample(
      "same-session",
      "2026-07-19T10:05:00.000Z",
      "stale-finished-late",
      8,
    );

    const [selected] = dedupeHistoryById([compacted, stale]);
    expect(selected?.revision).toBe(9);
    expect(selected?.name).toBe("compacted-new");
  });

  it("keeps the first canonical source when equal revisions have conflicting timestamps", async () => {
    const { dedupeHistoryById } = await import("../src/store/history.js");
    const canonical = sample(
      "equal-session",
      "2026-07-19T10:00:00.000Z",
      "canonical",
      12,
    );
    const finishedLater = sample(
      "equal-session",
      "2026-07-19T10:10:00.000Z",
      "conflicting-equal-revision",
      12,
    );

    const [selected] = dedupeHistoryById([canonical, finishedLater]);
    expect(selected?.name).toBe("canonical");
  });
});

describe("history recovery from orphan temps", () => {
  it("merges sessions from leftover .tmp snapshots into the active file", async () => {
    const { getJsonlHistoryPath, recoverOrphanedHistory, listSessions } =
      await import("../src/store/history.js");
    const main = getJsonlHistoryPath();
    expect(main.startsWith(dataDir)).toBe(true);
    const tmp = `${main}.99999.abc.tmp`;
    writeFileSync(
      main,
      `${JSON.stringify(sample("keep", "2024-01-01T00:00:00.000Z", "keep"))}\n`,
    );
    writeFileSync(
      tmp,
      [
        sample("keep", "2024-01-01T00:00:00.000Z", "keep"),
        sample("lost", "2023-01-01T00:00:00.000Z", "restored-chat"),
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    );

    const result = await recoverOrphanedHistory();
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    const sessions = await listSessions(50);
    const ids = sessions.map((s) => s.id);
    expect(ids).toContain("keep");
    expect(ids).toContain("lost");
    expect(existsSync(tmp)).toBe(false); // cleaned after successful merge
  });

  it("keeps archive rows out of active recovery but allows selected lookup", async () => {
    const {
      getHistoryArchivePath,
      getJsonlHistoryPath,
      getSession,
      listSessions,
      recoverOrphanedHistory,
    } = await import("../src/store/history.js");
    writeFileSync(
      getJsonlHistoryPath(),
      `${JSON.stringify(
        sample("active-session", "2026-07-19T10:05:00.000Z", "active", 5),
      )}\n`,
    );
    writeFileSync(
      getHistoryArchivePath(),
      `${JSON.stringify(
        sample("archived-session", "2026-07-19T10:00:00.000Z", "archived", 6),
      )}\n`,
    );

    const result = await recoverOrphanedHistory();
    expect(result.recovered).toBe(0);
    expect((await listSessions(10)).map((record) => record.id)).toEqual([
      "active-session",
    ]);
    expect(await getSession("archived-session")).toMatchObject({
      id: "archived-session",
      name: "archived",
      revision: 6,
    });
  });

  it("restores the newest rolling backup when active history is missing or corrupt", async () => {
    const {
      getHistoryBackupDir,
      getJsonlHistoryPath,
      listSessions,
      recoverOrphanedHistory,
    } = await import("../src/store/history.js");
    const backupDir = getHistoryBackupDir();
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      join(backupDir, "history-2026-07-20T00-00-00-000Z.jsonl"),
      `${JSON.stringify(
        sample("backup-session", "2026-07-20T00:00:00.000Z", "from-backup", 4),
      )}\n`,
    );

    const missing = await recoverOrphanedHistory();
    expect(missing.sources).toContain(
      "history-backups/history-2026-07-20T00-00-00-000Z.jsonl",
    );
    expect((await listSessions(10)).map((record) => record.id)).toContain(
      "backup-session",
    );

    writeFileSync(getJsonlHistoryPath(), "malformed-json\n");
    const corrupt = await recoverOrphanedHistory();
    expect(corrupt.sources).toContain(
      "history-backups/history-2026-07-20T00-00-00-000Z.jsonl",
    );
    expect((await listSessions(10)).map((record) => record.id)).toContain(
      "backup-session",
    );
  });
});

describe("destructive history clear", () => {
  it("clearAllHistory removes every recoverable history copy", async () => {
    const {
      clearAllHistory,
      getHistoryArchivePath,
      getHistoryBackupDir,
      getJsonlHistoryPath,
      getSession,
      listSessions,
    } = await import("../src/store/history.js");
    const main = getJsonlHistoryPath();
    const backupDir = getHistoryBackupDir();
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      main,
      `${JSON.stringify(sample("s1", "2024-06-01T00:00:00.000Z", "important"))}\n`,
    );
    writeFileSync(
      getHistoryArchivePath(),
      `${JSON.stringify(sample("archived", "2023-06-01T00:00:00.000Z"))}\n`,
    );
    writeFileSync(join(dataDir, "history.index.json"), "{}\n");
    writeFileSync(join(backupDir, "history-old.jsonl"), "important\n");
    writeFileSync(join(dataDir, "history-cleared-old.jsonl"), "important\n");
    writeFileSync(`${main}.123.old.tmp`, "important\n");

    const result = await clearAllHistory();
    expect(result).toMatchObject({ cleared: true });
    expect(result.detail).toContain("deleted");
    expect(await listSessions(50)).toEqual([]);
    expect(await getSession("archived")).toBeUndefined();

    const remaining = (await import("node:fs")).readdirSync(dataDir);
    expect(
      remaining.filter(
        (name) =>
          name === "history.jsonl" ||
          name === "history.index.json" ||
          name === "history-archive.jsonl" ||
          name === "history-backups" ||
          name.startsWith("history-cleared-") ||
          (name.startsWith("history.jsonl.") && name.endsWith(".tmp")),
      ),
    ).toEqual([]);
  });

  it("permanently removes one session from active, archived, and backup history", async () => {
    const {
      deleteSession,
      getHistoryArchivePath,
      getHistoryBackupDir,
      getJsonlHistoryPath,
      getSession,
      listSessions,
    } = await import("../src/store/history.js");
    const target = sample("remove-me", "2026-08-08T00:00:00.000Z");
    const retained = sample("keep-me", "2026-08-08T00:01:00.000Z");
    const backupDir = getHistoryBackupDir();
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(
      getJsonlHistoryPath(),
      `${JSON.stringify(target)}\n${JSON.stringify(retained)}\n`,
    );
    writeFileSync(
      getHistoryArchivePath(),
      `${JSON.stringify(target)}\n${JSON.stringify(retained)}\n`,
    );
    writeFileSync(
      join(backupDir, "history-before-delete.jsonl"),
      `${JSON.stringify(target)}\n${JSON.stringify(retained)}\n`,
    );

    expect(await deleteSession("remove-me")).toMatchObject({ deleted: true });
    expect(await getSession("remove-me")).toBeUndefined();
    expect((await listSessions(10)).map((record) => record.id)).toEqual(["keep-me"]);
    for (const file of [
      getJsonlHistoryPath(),
      getHistoryArchivePath(),
      join(backupDir, "history-before-delete.jsonl"),
    ]) {
      expect(readFileSync(file, "utf8")).not.toContain("remove-me");
    }
  });

  it("removes a session whose record spans many read chunks without corrupting neighboring records", async () => {
    // A single JSONL line this large forces the chunked line reader in
    // history.ts / history-index.ts to carry an unterminated fragment across
    // many 64KB reads before it sees the record's newline.
    const { deleteSession, getJsonlHistoryPath, getSession, listSessions } =
      await import("../src/store/history.js");
    const huge = sample("huge-record", "2026-08-08T00:02:00.000Z");
    (huge as unknown as { padding: string }).padding = "x".repeat(600 * 1024);
    const before = sample("before-huge", "2026-08-08T00:00:00.000Z");
    const after = sample("after-huge", "2026-08-08T00:01:00.000Z");
    writeFileSync(
      getJsonlHistoryPath(),
      `${JSON.stringify(before)}\n${JSON.stringify(huge)}\n${JSON.stringify(after)}\n`,
    );

    expect(await deleteSession("huge-record")).toMatchObject({ deleted: true });
    expect(await getSession("huge-record")).toBeUndefined();
    expect(await getSession("before-huge")).toBeDefined();
    expect(await getSession("after-huge")).toBeDefined();
    const ids = (await listSessions(10)).map((record) => record.id).sort();
    expect(ids).toEqual(["after-huge", "before-huge"]);
  });
});
