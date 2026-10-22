import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();
it.skipIf(!bun)("streams tool and job pagers in native OpenTUI without losing paused scroll", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./live-pagers.native.ts", import.meta.url))], { encoding: "utf8", timeout: 35_000, maxBuffer: 1024 * 1024 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native live pagers passed");
}, 40_000);
