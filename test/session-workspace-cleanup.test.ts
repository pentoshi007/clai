import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, lstat, lutimes, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearSessionWorkspaceActivity, protectSessionWorkspace, WORKSPACE_OWNERS_DIR } from "../src/store/session-workspace-activity.js";
import { cleanupSessionWorkspaces, scheduleSessionWorkspaceCleanup, SESSION_SCRATCH_RETENTION_MS, stopSessionWorkspaceCleanup } from "../src/store/session-workspace-cleanup.js";

const DAY = 24 * 60 * 60 * 1_000;
let root: string;
let parent: string;
let now: number;
let sequence: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-scratch-cleanup-"));
  parent = join(root, "sessions");
  await mkdir(parent);
  now = Date.now();
  sequence = 0;
});

afterEach(async () => {
  stopSessionWorkspaceCleanup();
  clearSessionWorkspaceActivity();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await cleanupSessionWorkspaces(join(root, "missing"));
  await chmod(parent, 0o700).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

async function age(path: string, at: number): Promise<void> {
  const info = await lstat(path);
  if (info.isDirectory() && !info.isSymbolicLink()) {
    for (const entry of await readdir(path)) await age(join(path, entry), at);
  }
  const time = at / 1_000;
  if (info.isSymbolicLink()) await lutimes(path, time, time);
  else await utimes(path, time, time);
}

async function workspace(days = 11, name?: string): Promise<string> {
  const folder = name ?? `${(++sequence).toString(16).padStart(6, "0")}-01-01-2000-00-00-00`;
  const path = join(parent, folder);
  await mkdir(join(path, "temp"), { recursive: true });
  await writeFile(join(path, "temp", "output.txt"), "saved output");
  await age(path, now - days * DAY);
  return path;
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(() => true, () => false);
}

describe("expired session scratch cleanup", () => {
  it("removes only recognised session folders inactive for more than ten days", async () => {
    expect(SESSION_SCRATCH_RETENTION_MS).toBe(10 * DAY);
    const old = await workspace(11);
    const collision = await workspace(11, "abcdef-01-01-2000-00-00-00-a1");
    const boundary = await workspace(10);
    const recent = await workspace(9);
    const unrelated = await workspace(30, "my-project");
    const malformed = await workspace(30, "abcdef-arbitrary-folder");
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(2);
    expect(await exists(old)).toBe(false);
    expect(await exists(collision)).toBe(false);
    for (const path of [boundary, recent, unrelated, malformed]) expect(await exists(path)).toBe(true);
  });

  it.each(["root", "nested output"])("preserves sub-millisecond cutoff rounding in %s", async (location) => {
    const path = await workspace(20);
    const cutoff = now - SESSION_SCRATCH_RETENTION_MS;
    const target = location === "root" ? path : join(path, "temp", "output.txt");
    await age(target, cutoff - 0.5);
    const modified = (await lstat(target)).mtimeMs;
    expect(modified).toBeLessThan(cutoff);
    expect(modified).toBeGreaterThan(cutoff - 1);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    expect(await exists(path)).toBe(true);
    expect(await readFile(join(path, "temp", "output.txt"), "utf8")).toBe("saved output");
  });

  it("removes workspaces beyond the millisecond cutoff guard", async () => {
    const path = await workspace(20);
    await age(path, now - SESSION_SCRATCH_RETENTION_MS - 2);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(1);
    expect(await exists(path)).toBe(false);
  });

  it("preserves an old folder when nested output was recently written", async () => {
    const path = await workspace(20);
    await mkdir(join(path, "nested", "deeper"), { recursive: true });
    await writeFile(join(path, "nested", "deeper", "fresh.txt"), "new output");
    await age(path, now - 20 * DAY);
    await utimes(join(path, "nested", "deeper", "fresh.txt"), new Date(now), new Date(now));
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    expect(await readFile(join(path, "temp", "output.txt"), "utf8")).toBe("saved output");
  });

  it("keeps current and earlier workspaces used by the running process", async () => {
    const earlier = await workspace(20);
    protectSessionWorkspace(earlier);
    const current = await workspace(20);
    protectSessionWorkspace(current);
    await age(earlier, now - 20 * DAY);
    await age(current, now - 20 * DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    expect(await exists(earlier)).toBe(true);
    expect(await exists(current)).toBe(true);
  });

  it("protects the current session even when its ownership marker cannot be created", async () => {
    const path = await workspace(20);
    await writeFile(join(path, WORKSPACE_OWNERS_DIR), "unavailable");
    protectSessionWorkspace(path);
    await age(path, now - 20 * DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    expect(await exists(path)).toBe(true);
  });

  it("reclaims abandoned sessions with dead process markers", async () => {
    const path = await workspace(20);
    await mkdir(join(path, WORKSPACE_OWNERS_DIR));
    await writeFile(join(path, WORKSPACE_OWNERS_DIR, "2147483647"), "");
    await age(path, now - 20 * DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(1);
    expect(await exists(path)).toBe(false);
  });

  it("fails closed on malformed ownership markers", async () => {
    const path = await workspace(20);
    await mkdir(join(path, WORKSPACE_OWNERS_DIR));
    await writeFile(join(path, WORKSPACE_OWNERS_DIR, "unknown"), "");
    await age(path, now - 20 * DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    expect(await exists(path)).toBe(true);
  });

  it("protects unexpected directories in the ownership marker directory", async () => {
    const path = await workspace(20);
    await mkdir(join(path, WORKSPACE_OWNERS_DIR, "2147483647"), { recursive: true });
    await age(path, now - 20 * DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    expect(await exists(join(path, "temp", "output.txt"))).toBe(true);
  });

  it("does not traverse symlinked session folders, parents, or nested targets", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep.txt"), "keep");
    const link = join(parent, "abcdef-01-01-2000-00-00-00");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    const path = await workspace(20);
    await symlink(outside, join(path, "linked-output"), process.platform === "win32" ? "junction" : "dir");
    await age(path, now - 20 * DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(1);
    expect(await exists(link)).toBe(true);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
    const parentLink = join(root, "parent-link");
    await symlink(parent, parentLink, process.platform === "win32" ? "junction" : "dir");
    expect(await cleanupSessionWorkspaces(parentLink, now + DAY)).toBe(0);
  });

  it("throttles completed scans across invocations and resumes the next day", async () => {
    const first = await workspace(20);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(1);
    const second = await workspace(20);
    expect(await cleanupSessionWorkspaces(parent, now + 1_000)).toBe(0);
    expect(await exists(second)).toBe(true);
    expect(await cleanupSessionWorkspaces(parent, now + DAY + 1)).toBe(1);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(false);
  });

  it("deduplicates overlapping cleanup calls", async () => {
    await workspace(20);
    const first = cleanupSessionWorkspaces(parent, now);
    const second = cleanupSessionWorkspaces(parent, now);
    expect(second).toBe(first);
    expect(await first).toBe(1);
  });

  it("skips a scan owned by another running process", async () => {
    const path = await workspace(20);
    const lock = join(parent, ".clai-cleanup-lock");
    await mkdir(lock);
    await writeFile(join(lock, String(process.pid)), "");
    await age(lock, now - DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    expect(await exists(path)).toBe(true);
  });

  it("recovers a cleanup lock left by a crashed process in the same pass", async () => {
    const path = await workspace(20);
    const lock = join(parent, ".clai-cleanup-lock");
    await mkdir(lock);
    await writeFile(join(lock, "2147483647"), "");
    await age(lock, now - DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(1);
    expect(await exists(path)).toBe(false);
    expect(await exists(lock)).toBe(false);
  });

  it("allows time for another process to initialise its cleanup lock", async () => {
    const path = await workspace(20);
    await mkdir(join(parent, ".clai-cleanup-lock"));
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    expect(await exists(path)).toBe(true);
  });

  it("handles missing or inaccessible storage silently", async () => {
    const stderr = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    expect(await cleanupSessionWorkspaces(join(root, "missing"), now)).toBe(0);
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      await chmod(parent, 0o000);
      expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    }
    expect(stderr).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("bounds traversal depth and preserves unusually deep trees", async () => {
    const path = await workspace(20);
    await mkdir(join(path, ...Array.from({ length: 40 }, () => "nested")), { recursive: true });
    await age(path, now - 20 * DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(0);
    expect(await exists(join(path, "temp", "output.txt"))).toBe(true);
  });

  it("cleans a wide output folder without bulk-loading its entries", async () => {
    const path = await workspace(20);
    for (let index = 0; index < 256; index += 1) {
      await writeFile(join(path, "temp", `${index}.txt`), "output");
    }
    await age(path, now - 20 * DAY);
    expect(await cleanupSessionWorkspaces(parent, now)).toBe(1);
    expect(await exists(path)).toBe(false);
  }, 10_000);

  it("runs in the background after startup and leaves its timers unreferenced", async () => {
    const path = await workspace(20);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timeout = vi.spyOn(globalThis, "setTimeout");
    scheduleSessionWorkspaceCleanup(parent);
    const initial = timeout.mock.results[0]?.value as NodeJS.Timeout;
    expect(initial.hasRef()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(async () => expect(await exists(path)).toBe(false));
    await cleanupSessionWorkspaces(parent, now);
    stopSessionWorkspaceCleanup();
    expect(vi.getTimerCount()).toBe(0);
  });
});
