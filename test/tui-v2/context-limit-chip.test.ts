import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("edits provider/model context limits from the native OpenTUI context chip", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./context-limit-chip.native.ts", import.meta.url))], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native context chip passed");
}, 70000);
