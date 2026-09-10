import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("keeps native live child inspection independent of the main turn", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./subagent-inspector.native.ts", import.meta.url))], {
    encoding: "utf8",
    timeout: 25000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native subagent inspector passed");
}, 30000);
