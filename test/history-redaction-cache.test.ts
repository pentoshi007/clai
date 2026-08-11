import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptItem } from "../app/ports/transcript-item.js";

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
  homeDir = mkdtempSync(join(tmpdir(), "clai-redact-home-"));
  configDir = mkdtempSync(join(tmpdir(), "clai-redact-config-"));
  dataDir = mkdtempSync(join(tmpdir(), "clai-redact-data-"));
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

function toolItem(index: number): TranscriptItem {
  return {
    kind: "tool",
    id: `t${index}`,
    name: "shell.exec",
    argsDisplay: `run step ${index} with a fairly long argument display line`,
    output: `output body for step ${index} ${"x".repeat(4_000)} token sk-abcdefghijklmnopqrstuv`,
    status: "ok",
    done: true,
  } as TranscriptItem;
}

describe("persistence redaction reuse", () => {
  it("redacts only the newly added items on each autosave", async () => {
    const { upsertSession, getSession } = await import("../src/store/history.js");
    const { redactionCacheStats, resetRedactionCache } = await import(
      "../src/store/redaction-cache.js"
    );

    const transcript: TranscriptItem[] = [];
    for (let index = 0; index < 40; index += 1) transcript.push(toolItem(index));
    await upsertSession("redact-session", [{ role: "user", content: "start" }], undefined, [
      ...transcript,
    ]);

    resetRedactionCache();
    transcript.push(toolItem(40));
    await upsertSession("redact-session", [{ role: "user", content: "start" }], undefined, [
      ...transcript,
    ]);

    const stats = redactionCacheStats();
    // Only the appended item's strings need a fresh regex pass.
    expect(stats.misses).toBeLessThanOrEqual(4);

    const restored = await getSession("redact-session");
    expect(restored?.transcript).toHaveLength(41);
    expect(restored?.transcript?.[0]?.kind).toBe("tool");
    const first = restored?.transcript?.[0] as { output: string };
    expect(first.output).not.toContain("sk-abcdefghijklmnopqrstuv");
  });
});
