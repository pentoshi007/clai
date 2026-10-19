import { spawnSync } from "node:child_process";
import { chownSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = process.platform === "linux" && process.getuid?.() === 0;
const OWNER = 4242;
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

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readAsOwner(path: string): string {
  const result = spawnSync(process.execPath, ["-e", "process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8'))", path], {
    uid: OWNER,
    gid: OWNER,
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe.skipIf(!root)("session runtime files written under sudo", () => {
  it("hands runtime directories, metadata and leases to the invoking user so a non-root clai can attach", async () => {
    const home = mkdtempSync(join(tmpdir(), "clai-runtime-sudo-"));
    dirs.push(home);
    chownSync(home, OWNER, OWNER);
    fixture.home = home;
    const data = join(home, ".clai");
    vi.stubEnv("SUDO_UID", String(OWNER));
    vi.stubEnv("SUDO_USER", "operator");
    vi.stubEnv("CLAI_DATA_DIR", data);
    vi.stubEnv("XDG_RUNTIME_DIR", "");
    vi.resetModules();
    const paths = await import("../../src/session-runtime/paths.js");
    const store = await import("../../src/session-runtime/store.js");
    const { RUNTIME_PROTOCOL_VERSION } = await import("../../src/session-runtime/types.js");
    const sessionId = "sess-sudo-shared";
    const now = new Date().toISOString();
    await store.writeRuntimeMetadata({
      version: RUNTIME_PROTOCOL_VERSION,
      sessionId,
      hostPid: process.pid,
      socketPath: paths.runtimeSocketPath(sessionId),
      token: store.createRuntimeToken(),
      cwd: home,
      startedAt: now,
      updatedAt: now,
      phase: "running",
      busy: true,
      attached: false,
    });
    const lease = await store.tryAcquireRuntimeLease(sessionId);
    expect(lease).toBeDefined();
    try {
      expect(statSync(data).uid).toBe(OWNER);
      for (const path of [paths.getRuntimeDir(), paths.getRuntimeSocketRoot()]) {
        expect(statSync(path).uid, path).toBe(OWNER);
        expect(statSync(path).mode & 0o777, path).toBe(0o700);
      }
      for (const path of [paths.runtimeMetadataPath(sessionId), paths.runtimeLockPath(sessionId)]) {
        expect(statSync(path).uid, path).toBe(OWNER);
        expect(statSync(path).mode & 0o777, path).toBe(0o600);
      }
      expect(JSON.parse(readAsOwner(paths.runtimeMetadataPath(sessionId))).sessionId).toBe(sessionId);
      expect(JSON.parse(readAsOwner(paths.runtimeLockPath(sessionId))).pid).toBe(process.pid);
    } finally {
      await lease?.release();
    }
  });
});
