import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("caps native collapsed diff bodies at 20 rows while preserving expanded views", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./diff-preview.native.ts", import.meta.url))], {
    encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, result.stderr || result.stdout).toBeUndefined();
  expect(result.signal, result.stderr || result.stdout).toBeNull();
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout).toContain("Native diff preview passed");
}, 50_000);
