import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("development launcher diagnostics", () => {
  it.each([
    ['{ status: null, signal: "SIGSEGV" }', "Bun crashed (SIGSEGV)"],
    ['{ status: null, error: new Error("spawn Bun EACCES") }', "could not start Bun: spawn Bun EACCES"],
  ])("explains an abnormal child exit", async (result, expected) => {
    const root = await mkdtemp(join(tmpdir(), "clai-dev-launcher-"));
    roots.push(root);
    await mkdir(join(root, "bin"));
    const executable = join(root, "bin", process.platform === "win32" ? "bun.exe" : "bun");
    await writeFile(executable, "fixture");
    await chmod(executable, 0o700);
    const preload = join(root, "preload.mjs");
    await writeFile(preload, `
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      childProcess.spawnSync = () => (${result});
      syncBuiltinESMExports();
    `);
    const script = fileURLToPath(new URL("../scripts/run-dev.mjs", import.meta.url));
    const child = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, BUN_INSTALL: root, CLAI_FORCE_NODE: "0" },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain(expected);
  });
});
