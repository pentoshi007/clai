import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("browses session prompts and route metadata in native OpenTUI", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "clai-native-prompts-"));
  try {
    const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./prompts.native.ts", import.meta.url))], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        CLAI_CONFIG_DIR: join(sandbox, "config"),
        CLAI_DATA_DIR: join(sandbox, "data"),
        CLAI_HISTORY_DIR: join(sandbox, "history"),
        CLAI_PLAN_DIR: join(sandbox, "plans"),
        CLAI_LOG_DIR: join(sandbox, "logs"),
        CLAI_ARTIFACT_DIR: join(sandbox, "artifacts"),
        CLAI_JOBS_DIR: join(sandbox, "jobs"),
        CLAI_NO_UPDATE_CHECK: "1",
        CLAI_DISABLE_KEYCHAIN: "1",
      },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Native prompts passed");
    expect(result.stderr).not.toContain("pager source is disposed");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}, 70000);
