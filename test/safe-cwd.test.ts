import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { safeCwd, cwdIsBroken, recoverCwd } from "../src/os/cwd.js";

describe("safeCwd (deleted working directory resilience)", () => {
  const startDir = process.cwd();

  afterEach(() => {
    // Always restore a sane cwd so other tests aren't affected.
    try {
      process.chdir(startDir);
    } catch {
      process.chdir(homedir());
    }
  });

  it("returns the real cwd when it exists", () => {
    expect(safeCwd()).toBe(process.cwd());
    expect(cwdIsBroken()).toBe(false);
  });

  it("does not throw and recovers when the cwd was deleted", () => {
    const tmp = mkdtempSync(join(tmpdir(), "clai-cwd-test-"));
    process.chdir(tmp);
    rmdirSync(tmp); // pull the rug out from under the process

    expect(cwdIsBroken()).toBe(true);
    // The key assertion: safeCwd must NOT throw (the original bug threw
    // ENOENT uv_cwd and crashed everything downstream).
    const recovered = safeCwd();
    expect(typeof recovered).toBe("string");
    expect(recovered.length).toBeGreaterThan(0);
    expect(existsSync(recovered)).toBe(true);
    // After recovery the process cwd is valid again.
    expect(cwdIsBroken()).toBe(false);
  });

  it("recoverCwd relocates to an existing directory", () => {
    const tmp = mkdtempSync(join(tmpdir(), "clai-cwd-test-"));
    process.chdir(tmp);
    rmdirSync(tmp);
    const dir = recoverCwd();
    expect(existsSync(dir)).toBe(true);
  });
});
