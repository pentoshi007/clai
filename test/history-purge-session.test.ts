import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSession, purgeSession, saveSession } from "../src/store/history.js";
import {
  bindSessionWorkspace,
  clearActiveSessionWorkspace,
  mintSessionWorkspace,
  sessionWorkspaceRoot,
  type SessionWorkspace,
} from "../src/store/session-workspace.js";
import type { ChatMessage } from "../src/types.js";

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
const madeWorkspaces: SessionWorkspace[] = [];

function workspaceWithArtifact(): SessionWorkspace {
  const workspace = bindSessionWorkspace(mintSessionWorkspace());
  madeWorkspaces.push(workspace);
  mkdirSync(workspace.tempDir, { recursive: true });
  writeFileSync(join(workspace.tempDir, "output.txt"), "tool output");
  return workspace;
}

beforeEach(() => {
  originalEnv = {};
  for (const key of dataEnvKeys) originalEnv[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "clai-purge-"));
  process.env.CLAI_DATA_DIR = dataDir;
  process.env.CLAI_HISTORY_DIR = dataDir;
  process.env.CLAI_CONFIG_DIR = dataDir;
  process.env.CLAI_PLAN_DIR = dataDir;
  process.env.CLAI_LOG_DIR = join(dataDir, "logs");
  process.env.CLAI_ARTIFACT_DIR = join(dataDir, "artifacts");
  process.env.CLAI_JOBS_DIR = join(dataDir, "jobs");
});

afterEach(async () => {
  clearActiveSessionWorkspace();
  for (const workspace of madeWorkspaces.splice(0)) {
    await rm(workspace.rootDir, { recursive: true, force: true });
  }
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

describe("purgeSession", () => {
  it("removes the session record and its artifact workspace", async () => {
    const workspace = workspaceWithArtifact();
    const record = await saveSession(MESSAGES, "purge me");
    expect(record.workspaceFolder).toBe(workspace.folderName);
    expect(await getSession(record.id)).toBeDefined();

    const result = await purgeSession(record.id);

    expect(result.deleted).toBe(true);
    expect(result.removedWorkspace).toBe(true);
    expect(await getSession(record.id)).toBeUndefined();
    expect(existsSync(sessionWorkspaceRoot(workspace.folderName))).toBe(false);
  });

  it("still deletes a session that has no workspace recorded", async () => {
    clearActiveSessionWorkspace();
    const record = await saveSession(MESSAGES, "no workspace");

    const result = await purgeSession(record.id);

    expect(result.deleted).toBe(true);
    expect(result.removedWorkspace).toBe(false);
    expect(await getSession(record.id)).toBeUndefined();
  });

  it("reports a miss for an unknown session instead of throwing", async () => {
    const result = await purgeSession("does-not-exist");
    expect(result.deleted).toBe(false);
    expect(result.removedWorkspace).toBe(false);
  });

  it("rejects an empty session id", async () => {
    const result = await purgeSession("   ");
    expect(result).toMatchObject({
      deleted: false,
      detail: "missing session id",
    });
  });

  it("leaves other sessions and their workspaces untouched", async () => {
    const keep = workspaceWithArtifact();
    const keeper = await saveSession(MESSAGES, "keeper");
    const goner = workspaceWithArtifact();
    const doomed = await saveSession(MESSAGES, "goner");

    await purgeSession(doomed.id);

    expect(await getSession(keeper.id)).toBeDefined();
    expect(existsSync(sessionWorkspaceRoot(keep.folderName))).toBe(true);
    expect(existsSync(sessionWorkspaceRoot(goner.folderName))).toBe(false);
  });
});
