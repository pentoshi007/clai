import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("dispatches slash commands reliably through the native composer", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./slash-commands.native.ts", import.meta.url))], {
    encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native slash commands passed");
}, 50000);
