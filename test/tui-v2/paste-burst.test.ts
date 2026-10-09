import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { findBunExecutable } from "../../src/os/bun-runtime.js";

const bun = findBunExecutable();

it("installs the paste burst guard when the OpenTUI renderer starts", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../src/tui-v2/bootstrap/start-tui-v2.ts", import.meta.url)),
    "utf8",
  );
  expect(source).toContain("installPasteBurstGuard<KeyEvent>(renderer.keyInput)");
  expect(source).toMatch(/disposers:\s*\[\s*disposePasteBurstGuard,/);
});

it.skipIf(!bun)("preserves large pastes with stable previews and cursor-based keyboard expansion in OpenTUI", () => {
  const result = spawnSync(bun!, ["run", fileURLToPath(new URL("./paste-burst.native.ts", import.meta.url))], {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("Native paste burst passed");
}, 70000);
