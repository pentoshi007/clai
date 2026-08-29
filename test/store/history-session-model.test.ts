import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getSession,
  purgeSession,
  saveSession,
  upsertSession,
} from "../../src/store/history.js";
import {
  getSessionModelPath,
  saveSessionModel,
} from "../../src/store/session-model.js";
import { clearActiveSessionWorkspace } from "../../src/store/session-workspace.js";
import type { ChatMessage } from "../../src/types.js";

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
let originalEnv: Partial<Record<(typeof dataEnvKeys)[number], string | undefined>>;

beforeEach(() => {
  originalEnv = {};
  for (const key of dataEnvKeys) originalEnv[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "clai-history-model-"));
  process.env.CLAI_DATA_DIR = dataDir;
  process.env.CLAI_HISTORY_DIR = dataDir;
  process.env.CLAI_CONFIG_DIR = dataDir;
  process.env.CLAI_PLAN_DIR = dataDir;
  process.env.CLAI_LOG_DIR = join(dataDir, "logs");
  process.env.CLAI_ARTIFACT_DIR = join(dataDir, "artifacts");
  process.env.CLAI_JOBS_DIR = join(dataDir, "jobs");
  clearActiveSessionWorkspace();
});

afterEach(async () => {
  clearActiveSessionWorkspace();
  for (const key of dataEnvKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  await rm(dataDir, { recursive: true, force: true });
});

const MESSAGES: ChatMessage[] = [
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

describe("history record provider/model round-trip", () => {
  it("persists and restores a per-session provider/model", async () => {
    const record = await saveSession(
      MESSAGES,
      "with model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { provider: "nvidia", model: "openai/gpt-oss-20b" },
    );
    expect(record.provider).toBe("nvidia");
    expect(record.model).toBe("openai/gpt-oss-20b");

    const loaded = await getSession(record.id);
    expect(loaded?.provider).toBe("nvidia");
    expect(loaded?.model).toBe("openai/gpt-oss-20b");
  });

  it("loads an older record with no provider/model as undefined", async () => {
    const record = await saveSession(MESSAGES, "legacy");
    const loaded = await getSession(record.id);
    expect(loaded).toBeDefined();
    expect(loaded?.provider).toBeUndefined();
    expect(loaded?.model).toBeUndefined();
  });

  it("preserves an existing binding when a later upsert omits it", async () => {
    const id = "sess-upsert-model";
    await upsertSession(
      id,
      MESSAGES,
      "first",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { provider: "gemini", model: "gemini-3.5-flash" },
    );
    await upsertSession(id, [...MESSAGES, { role: "user", content: "again" }], "second");

    const loaded = await getSession(id);
    expect(loaded?.provider).toBe("gemini");
    expect(loaded?.model).toBe("gemini-3.5-flash");
  });

  it("releases the per-session model file when history is purged", async () => {
    const id = "sess-purge-model";
    await upsertSession(id, MESSAGES, "purge route");
    await saveSessionModel(id, { provider: "nvidia", model: "route-model" });
    expect(existsSync(getSessionModelPath(id))).toBe(true);

    await purgeSession(id);

    expect(existsSync(getSessionModelPath(id))).toBe(false);
  });
});
