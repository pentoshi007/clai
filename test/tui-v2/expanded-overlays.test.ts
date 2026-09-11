import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("renders expanded overlays and safe orchestration options with the native renderer", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./expanded-overlays.native.ts", import.meta.url))], {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native expanded overlays passed");
}, 50000);
