import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("navigates history continuously without hover jumps or transcript scrolling", () => {
  const directory = mkdtempSync(join(tmpdir(), "clai-history-navigation-"));
  try {
    const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./history-navigation.native.ts", import.meta.url))], {
      encoding: "utf8",
      timeout: 45000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        CLAI_DATA_DIR: directory,
        CLAI_HISTORY_DIR: directory,
        CLAI_PLAN_DIR: directory,
      },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Native history navigation passed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 50000);
