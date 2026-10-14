import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it.skipIf(!bun)("keeps native scrolling and streaming responsive without subscription churn or cursor content work", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./interaction-performance.native.ts", import.meta.url))], {
    env: { ...process.env, CLAI_OFFLINE: "1", CLAI_NO_UPDATE_CHECK: "1" },
    encoding: "utf8", timeout: 45_000, maxBuffer: 4 * 1024 * 1024,
  });
  const evidence = result.stderr || result.stdout;
  expect(result.error, evidence).toBeUndefined();
  expect(result.signal, evidence).toBeNull();
  expect(result.status, evidence).toBe(0);
  expect(result.stdout).toContain("Native interaction performance passed");
}, 50_000);
