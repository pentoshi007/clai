import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("keeps OpenTUI stop clicks immediate, hover fixed-width and Esc foreground-only", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./foreground-cancel.native.ts", import.meta.url))], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native foreground cancellation passed");
}, 70000);
