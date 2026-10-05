import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";
import { qoderRuntimeEnvironment } from "../fixtures/qoder-runtime-environment.js";

const bun = findBunExecutable();
it.skipIf(!bun).each([80, 120])("OpenTUI Qoder auth and account controls at %i columns", (width) => {
  const sandbox = mkdtempSync(join(tmpdir(), "clai-qoder-opentui-"));
  try {
    const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./qoder-auth.native.ts", import.meta.url)), String(width)], {
      env: qoderRuntimeEnvironment(sandbox), encoding: "utf8", timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`OpenTUI Qoder auth passed at ${width} columns`);
  } finally { rmSync(sandbox, { recursive: true, force: true }); }
}, 70_000);
