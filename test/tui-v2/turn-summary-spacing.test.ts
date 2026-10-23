import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();
it.skipIf(!bun)("separates the turn summary from the next transcript row", () => {
  const result = spawnSync(
    bun!,
    ["run", fileURLToPath(new URL("./turn-summary-spacing.native.ts", import.meta.url))],
    { encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024 },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Turn summary spacing passed");
}, 50_000);
