import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();
it.skipIf(!bun)("copies code blocks from the copy tab and framed selections in native OpenTUI", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./code-block-copy.native.ts", import.meta.url))], { encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native code block copy passed");
}, 50_000);
