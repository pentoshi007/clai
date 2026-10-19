import { chownSync, linkSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const root = process.platform !== "win32" && process.getuid?.() === 0;
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

describe.skipIf(!root || process.platform !== "linux")("handing clai storage back to the invoking user", () => {
  it("returns root-owned clai files without following links or touching foreign files", async () => {
    const home = mkdtempSync(join(tmpdir(), "clai-ownership-"));
    dirs.push(home);
    fixture.home = home;
    const outside = mkdtempSync(join(tmpdir(), "clai-ownership-outside-"));
    dirs.push(outside);
    const data = join(home, ".clai");
    mkdirSync(join(data, "history", "prompts"), { recursive: true });
    writeFileSync(join(data, "history", "history.jsonl"), "{}\n");
    writeFileSync(join(data, "history", "prompts", "prompts.md"), "x");
    writeFileSync(join(data, "foreign.txt"), "y");
    chownSync(join(data, "foreign.txt"), 31337, 31337);
    const secret = join(outside, "secret");
    writeFileSync(secret, "root only");
    symlinkSync(secret, join(data, "escape"));
    linkSync(secret, join(data, "hardlink"));
    vi.stubEnv("SUDO_UID", String(OWNER));
    vi.stubEnv("SUDO_USER", "operator");
    vi.stubEnv("CLAI_DATA_DIR", data);
    vi.resetModules();
    const { repairClaiOwnership, claiStorageRoots } = await import("../../src/store/ownership.js");
    expect(claiStorageRoots()).toContain(data);
    const result = await repairClaiOwnership(10_000);
    expect(result.complete).toBe(true);
    expect(statSync(join(data, "history", "history.jsonl")).uid).toBe(OWNER);
    expect(statSync(join(data, "history", "prompts", "prompts.md")).uid).toBe(OWNER);
    expect(statSync(join(data, "history")).uid).toBe(OWNER);
    expect(lstatSync(join(data, "escape")).uid).toBe(OWNER);
    expect(statSync(secret).uid).toBe(0);
    expect(statSync(join(data, "hardlink")).uid).toBe(0);
    expect(statSync(join(data, "foreign.txt")).uid).toBe(31337);
  });

  it("never sweeps configured storage outside the invoking user's home", async () => {
    const home = mkdtempSync(join(tmpdir(), "clai-ownership-home-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "clai-ownership-elsewhere-"));
    dirs.push(home, elsewhere);
    fixture.home = home;
    writeFileSync(join(elsewhere, "system.conf"), "z");
    vi.stubEnv("SUDO_UID", String(OWNER));
    vi.stubEnv("SUDO_USER", "operator");
    vi.stubEnv("CLAI_DATA_DIR", elsewhere);
    vi.resetModules();
    const { repairClaiOwnership, claiStorageRoots } = await import("../../src/store/ownership.js");
    expect(claiStorageRoots()).not.toContain(elsewhere);
    await repairClaiOwnership(10_000);
    expect(statSync(join(elsewhere, "system.conf")).uid).toBe(0);
  });
});

describe("ownership failure reporting", () => {
  it("reports ownership failures instead of swallowing them", async () => {
    vi.stubEnv("SUDO_UID", String(OWNER));
    vi.stubEnv("SUDO_USER", "operator");
    fixture.home = "/nonexistent-home";
    vi.resetModules();
    const { onOwnershipFailure, reportOwnershipFailure } = await import("../../src/os/permissions.js");
    const failures: unknown[] = [];
    const stop = onOwnershipFailure((failure) => failures.push(failure));
    reportOwnershipFailure("/x", Object.assign(new Error("ro"), { code: "EROFS" }), "operator");
    reportOwnershipFailure("/y", Object.assign(new Error("gone"), { code: "ENOENT" }), "operator");
    stop();
    reportOwnershipFailure("/z", Object.assign(new Error("ro"), { code: "EROFS" }), "operator");
    expect(failures).toEqual([{ path: "/x", code: "EROFS", username: "operator" }]);
  });
});
