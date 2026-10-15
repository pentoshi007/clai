import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();
const cases = [
  ["jump-to-latest", "Native jump-to-latest passed"],
  ["queue-panel", "Native queue panel passed"],
  ["toast-centered", "Native centered toasts passed"],
  ["tool-output-preview", "Native output previews passed"],
] as const;

describe.skipIf(!bun)("native terminal presentation", () => {
  it.each(cases)("verifies %s across terminal widths", (name, success) => {
    const result = spawnSync(bun!, ["run", fileURLToPath(new URL(`./${name}.native.ts`, import.meta.url))], {
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, CLAI_NO_UPDATE_CHECK: "1", CLAI_DISABLE_KEYCHAIN: "1" },
    });
    expect(result.error).toBeUndefined();
    expect(result.signal, result.stderr).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(success);
  }, 50_000);
});
