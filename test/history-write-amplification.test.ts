import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataEnvKeys = [
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
] as const;

let originalHome: string | undefined;
let originalConfigDir: string | undefined;
let originalDataEnv: Partial<Record<(typeof dataEnvKeys)[number], string | undefined>>;
let homeDir: string;
let configDir: string;
let dataDir: string;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalConfigDir = process.env.CLAI_CONFIG_DIR;
  originalDataEnv = {};
  for (const key of dataEnvKeys) originalDataEnv[key] = process.env[key];
  homeDir = mkdtempSync(join(tmpdir(), "clai-history-amp-home-"));
  configDir = mkdtempSync(join(tmpdir(), "clai-history-amp-config-"));
  dataDir = mkdtempSync(join(tmpdir(), "clai-history-amp-data-"));
  process.env.HOME = homeDir;
  process.env.CLAI_CONFIG_DIR = configDir;
  process.env.CLAI_DATA_DIR = dataDir;
  for (const key of dataEnvKeys) {
    if (key !== "CLAI_DATA_DIR") delete process.env[key];
  }
  vi.resetModules();
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalConfigDir === undefined) delete process.env.CLAI_CONFIG_DIR;
  else process.env.CLAI_CONFIG_DIR = originalConfigDir;
  for (const key of dataEnvKeys) {
    const value = originalDataEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(homeDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  vi.resetModules();
});

function countLines(path: string): number {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

describe("history write amplification", () => {
  it("appends the changed session instead of rewriting other sessions", async () => {
    const { upsertSession, listSessions, getHistoryPath, getSession } = await import(
      "../src/store/history.js"
    );

    const bulk = "b".repeat(200_000);
    await upsertSession("big-session", [{ role: "user", content: bulk }]);
    const path = getHistoryPath();
    const afterBig = statSync(path).size;

    for (let turn = 1; turn <= 4; turn += 1) {
      await upsertSession("small-session", [
        { role: "user", content: "hello" },
        { role: "assistant", content: `answer ${turn}` },
      ]);
    }

    const size = statSync(path).size;
    expect(size).toBeGreaterThan(afterBig);
    // Four small appends must not cost four copies of the large session.
    expect(size - afterBig).toBeLessThan(afterBig / 2);
    expect(countLines(path)).toBeGreaterThan(2);

    const sessions = await listSessions(10);
    expect(sessions.map((session) => session.id).sort()).toEqual([
      "big-session",
      "small-session",
    ]);
    const restored = await getSession("small-session");
    expect(restored?.messages[1]?.content).toBe("answer 4");
  });

  it("compacts once superseded lines dominate the active file", async () => {
    const { upsertSession, getHistoryPath, getSession } = await import(
      "../src/store/history.js"
    );

    const bulk = "c".repeat(2_100_000);
    for (let turn = 1; turn <= 5; turn += 1) {
      await upsertSession("fat-session", [
        { role: "user", content: bulk },
        { role: "assistant", content: `revision ${turn}` },
      ]);
    }

    const path = getHistoryPath();
    expect(countLines(path)).toBe(1);
    const restored = await getSession("fat-session");
    expect(restored?.messages[1]?.content).toBe("revision 5");
  });

  it("amortizes compaction instead of rewriting a large session on every save", async () => {
    const { upsertSession, getHistoryPath, getSession } = await import(
      "../src/store/history.js"
    );
    const bulk = "d".repeat(400_000);
    for (let turn = 1; turn <= 5; turn += 1) {
      await upsertSession("amortized-session", [
        { role: "user", content: bulk },
        { role: "assistant", content: `revision ${turn}` },
      ]);
    }
    expect(countLines(getHistoryPath())).toBe(5);
    const restored = await getSession("amortized-session");
    expect(restored?.messages[1]?.content).toBe("revision 5");
  });
});
