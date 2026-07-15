import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
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
): {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  messages: { role: string; content: string }[];
} {
  return {
    id,
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
});

describe("history clear archives instead of destroying", () => {
  it("clearAllHistory moves sessions to archive/backup", async () => {
    const { clearAllHistory, getJsonlHistoryPath, listSessions } =
      await import("../src/store/history.js");
    const main = getJsonlHistoryPath();
    writeFileSync(
      main,
      `${JSON.stringify(sample("s1", "2024-06-01T00:00:00.000Z", "important"))}\n`,
    );

    const result = await clearAllHistory();
    expect(result.cleared).toBe(true);
    expect(result.detail).toMatch(/recoverable|backed up|moved/i);

    // Active list empty
    expect(await listSessions(50)).toEqual([]);

    // Cleared copy still has the session text (not permanently destroyed)
    const dir = dataDir;
    const cleared = (await import("node:fs")).readdirSync(dir).filter((n) =>
      n.startsWith("history-cleared-"),
    );
    expect(cleared.length).toBeGreaterThanOrEqual(1);
    const body = readFileSync(join(dir, cleared[0]!), "utf8");
    expect(body).toContain("important");
    expect(body).toContain("s1");
  });
});
