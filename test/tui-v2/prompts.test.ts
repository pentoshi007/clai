import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("browses session prompts and route metadata in native OpenTUI", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./prompts.native.ts", import.meta.url))], {
    encoding: "utf8", timeout: 60000, maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native prompts passed");
}, 70000);
