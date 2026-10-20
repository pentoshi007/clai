import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("routes Ink's line measurement through the fast width implementation under Bun", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./widest-line-override.native.ts", import.meta.url))], {
    encoding: "utf8",
    timeout: 30000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Widest-line override passed");
}, 35000);
