import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("repaints the whole OpenTUI screen on F5 and /redraw, even behind an overlay", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./screen-redraw.native.ts", import.meta.url))], {
    encoding: "utf8",
    timeout: 45000,
    maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native screen redraw passed");
}, 50000);
