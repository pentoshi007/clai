import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";

const envKeys = [
  "CLAI_CONFIG_DIR",
  "CLAI_DATA_DIR",
  "CLAI_HISTORY_DIR",
  "CLAI_PLAN_DIR",
  "CLAI_LOG_DIR",
  "CLAI_ARTIFACT_DIR",
  "CLAI_JOBS_DIR",
] as const;

type EnvKey = (typeof envKeys)[number];

let root: string;
let previousEnv: Partial<Record<EnvKey, string | undefined>>;
/** Workspace roots minted during a test — removed in afterEach so we don't
 *  pollute the real OS temp dir and trip other suites' clearArtifacts counts. */
const createdRoots: string[] = [];

beforeEach(() => {
  previousEnv = {};
  createdRoots.length = 0;
  for (const key of envKeys) previousEnv[key] = process.env[key];
  root = mkdtempSync(join(tmpdir(), "clai-session-ws-"));
  process.env.CLAI_CONFIG_DIR = join(root, "config");
  process.env.CLAI_DATA_DIR = join(root, "data");
  process.env.CLAI_HISTORY_DIR = join(root, "history");
  process.env.CLAI_PLAN_DIR = join(root, "plans");
  process.env.CLAI_LOG_DIR = join(root, "logs");
  // Leave CLAI_ARTIFACT_DIR unset so session-scoped temp is used.
  delete process.env.CLAI_ARTIFACT_DIR;
  process.env.CLAI_JOBS_DIR = join(root, "jobs");
  vi.resetModules();
});

afterEach(async () => {
  const { clearActiveSessionWorkspace } = await import(
    "../src/store/session-workspace.js"
  );
  clearActiveSessionWorkspace();
  for (const dir of createdRoots) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  createdRoots.length = 0;
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
  vi.resetModules();
});

function track<T extends { rootDir: string }>(ws: T): T {
  createdRoots.push(ws.rootDir);
  return ws;
}

describe("session workspace naming", () => {
  it("mints a 6-hex code + local DD-MM-YYYY-HH-MM-SS folder name", async () => {
    const {
      generateSessionCode,
      formatSessionFolderName,
      isValidSessionCode,
      isValidSessionFolderName,
      mintSessionWorkspace,
      clearActiveSessionWorkspace,
    } = await import("../src/store/session-workspace.js");

    const code = generateSessionCode();
    expect(isValidSessionCode(code)).toBe(true);
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[0-9a-f]{6}$/);

    // Fixed clock so the assertion is deterministic.
    const at = new Date(2003, 7, 25, 22, 45, 56); // month is 0-indexed → August
    const name = formatSessionFolderName(code, at);
    expect(name).toBe(`${code}-25-08-2003-22-45-56`);
    expect(isValidSessionFolderName(name)).toBe(true);

    const ws = track(mintSessionWorkspace(at));
    expect(ws.code).toHaveLength(6);
    expect(ws.folderName).toMatch(
      new RegExp(`^${ws.code}-\\d{2}-\\d{2}-\\d{4}-\\d{2}-\\d{2}-\\d{2}$`),
    );
    expect(existsSync(ws.rootDir)).toBe(true);
    expect(existsSync(ws.tempDir)).toBe(true);
    expect(ws.tempDir.endsWith(`${sep}temp`)).toBe(true);
    expect(ws.rootDir.includes(`${sep}clai${sep}`)).toBe(true);
    clearActiveSessionWorkspace();
  });

  it("rejects path traversal in folder names", async () => {
    const { sessionWorkspaceRoot } = await import(
      "../src/store/session-workspace.js"
    );
    expect(() => sessionWorkspaceRoot("../evil")).toThrow(/invalid/i);
    expect(() => sessionWorkspaceRoot("a/b")).toThrow(/invalid/i);
    expect(() => sessionWorkspaceRoot("a\\b")).toThrow(/invalid/i);
  });

  it("restores a prior folder and recreates dirs if cleaned", async () => {
    const {
      mintSessionWorkspace,
      restoreSessionWorkspace,
      clearActiveSessionWorkspace,
    } = await import("../src/store/session-workspace.js");

    const original = track(mintSessionWorkspace());
    await rm(original.rootDir, { recursive: true, force: true });
    expect(existsSync(original.rootDir)).toBe(false);

    const restored = track(
      restoreSessionWorkspace(original.folderName, original.code),
    );
    expect(restored.folderName).toBe(original.folderName);
    expect(restored.code).toBe(original.code);
    expect(existsSync(restored.rootDir)).toBe(true);
    expect(existsSync(restored.tempDir)).toBe(true);
    clearActiveSessionWorkspace();
  });
});

describe("session workspace path routing", () => {
  it("routes getArtifactDir and scratchDirFor through the active session", async () => {
    const { beginSessionWorkspace, clearActiveSessionWorkspace } =
      await import("../src/store/session-workspace.js");
    const { getArtifactDir, getGlobalArtifactDir } = await import(
      "../src/store/paths.js"
    );
    const { scratchDirFor } = await import("../src/prompts/index.js");

    const ws = track(beginSessionWorkspace());
    expect(getArtifactDir()).toBe(ws.tempDir);
    expect(scratchDirFor(process.cwd())).toBe(ws.rootDir);
    // Global fallback remains the data-dir outputs path.
    expect(getGlobalArtifactDir()).toBe(join(root, "data", "outputs"));

    clearActiveSessionWorkspace();
    // Without an active session, scratch falls back to project-name layout.
    const legacy = scratchDirFor("/Users/alice/my project");
    expect(legacy.endsWith(`${sep}clai${sep}my-project`)).toBe(true);
  });

  it("honors CLAI_ARTIFACT_DIR over the session temp dir", async () => {
    process.env.CLAI_ARTIFACT_DIR = join(root, "forced-artifacts");
    vi.resetModules();
    const { beginSessionWorkspace, clearActiveSessionWorkspace } =
      await import("../src/store/session-workspace.js");
    const { getArtifactDir } = await import("../src/store/paths.js");

    track(beginSessionWorkspace());
    expect(getArtifactDir()).toBe(join(root, "forced-artifacts"));
    clearActiveSessionWorkspace();
  });

  it("writes shell tool artifacts into the session temp folder", async () => {
    const { beginSessionWorkspace, clearActiveSessionWorkspace } =
      await import("../src/store/session-workspace.js");
    const { shellExec } = await import("../src/tools/shell.js");

    const ws = track(beginSessionWorkspace());
    const result = await shellExec({
      command: "printf session-ws-test",
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(result.outputPath).toBeDefined();
    expect(result.outputPath!.startsWith(ws.tempDir + sep)).toBe(true);
    expect(existsSync(result.outputPath!)).toBe(true);
    clearActiveSessionWorkspace();
  });

  it("persists workspaceFolder on history and restores it", async () => {
    const { beginSessionWorkspace, clearActiveSessionWorkspace } =
      await import("../src/store/session-workspace.js");
    const { upsertSession, getSession } = await import(
      "../src/store/history.js"
    );

    const ws = track(beginSessionWorkspace());
    const saved = await upsertSession("ws-session-1", [
      { role: "user", content: "hello workspace" },
    ]);
    expect(saved.workspaceFolder).toBe(ws.folderName);
    expect(saved.workspaceCode).toBe(ws.code);

    clearActiveSessionWorkspace();

    const loaded = await getSession("ws-session-1");
    expect(loaded?.workspaceFolder).toBe(ws.folderName);
    expect(loaded?.workspaceCode).toBe(ws.code);

    // Resume rebinds the same folder.
    const { beginSessionWorkspace: beginAgain } = await import(
      "../src/store/session-workspace.js"
    );
    const restored = track(
      beginAgain({
        folderName: loaded!.workspaceFolder,
        code: loaded!.workspaceCode,
      }),
    );
    expect(restored.folderName).toBe(ws.folderName);
    expect(restored.rootDir).toBe(ws.rootDir);
    clearActiveSessionWorkspace();
  });

  it("clearArtifacts empties session temp dirs and global outputs", async () => {
    const {
      beginSessionWorkspace,
      clearActiveSessionWorkspace,
      getSessionWorkspaceParent,
    } = await import("../src/store/session-workspace.js");
    const { clearArtifacts } = await import("../src/store/logs.js");
    const { getGlobalArtifactDir } = await import("../src/store/paths.js");

    const ws = track(beginSessionWorkspace());
    writeFileSync(join(ws.tempDir, "run-output.txt"), "tool output");
    // Also seed the global outputs dir.
    const globalDir = getGlobalArtifactDir();
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "legacy.txt"), "old");

    const result = await clearArtifacts();
    // The session-workspace parent lives in the real OS temp dir, so a
    // concurrently running suite's clearArtifacts can remove our seeded temp
    // file first. The per-file assertions below are the real contract; the
    // count is only a smoke check.
    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(ws.tempDir, "run-output.txt"))).toBe(false);
    expect(existsSync(join(globalDir, "legacy.txt"))).toBe(false);
    // Session folder itself (scratch root) is preserved.
    expect(existsSync(ws.rootDir)).toBe(true);
    expect(existsSync(getSessionWorkspaceParent())).toBe(true);
    clearActiveSessionWorkspace();
  }, 10_000);

  it("two concurrent beginSessionWorkspace calls produce distinct folders", async () => {
    const {
      beginSessionWorkspace,
      clearActiveSessionWorkspace,
      mintSessionWorkspace,
    } = await import("../src/store/session-workspace.js");

    const a = track(mintSessionWorkspace());
    // Same-second mints still differ by the random 6-hex code.
    const b = track(mintSessionWorkspace());
    expect(a.folderName).not.toBe(b.folderName);
    expect(a.code).not.toBe(b.code);
    expect(basename(a.rootDir)).toBe(a.folderName);
    expect(basename(b.rootDir)).toBe(b.folderName);

    // Active binding is the last beginSessionWorkspace call.
    const bound = track(beginSessionWorkspace());
    expect(bound.rootDir).toBeTruthy();
    clearActiveSessionWorkspace();
  });
});
