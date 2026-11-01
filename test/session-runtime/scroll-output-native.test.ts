import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("compacts both real UIs without losing transcript, draft or resize behavior", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./scroll-output.native.ts", import.meta.url))], {
    encoding: "utf8", timeout: 45000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, CLAI_NO_UPDATE_CHECK: "1", CLAI_DISABLE_KEYCHAIN: "1" },
  });
  expect(result.error?.message ?? "").toBe("");
  expect(result.status, result.stderr || result.stdout).toBe(0);
  expect(result.stdout).toContain("[PASS] Scroll output:");
}, 50000);
