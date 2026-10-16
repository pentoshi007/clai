import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runAssemblyMeasurement(destination: string): Promise<string> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = resolve(destination);
  const result = spawnSync(process.execPath, [
    resolve(root, "node_modules/vitest/vitest.mjs"), "run", "test/context/token-assembly-baseline.test.ts", "--reporter=dot",
  ], {
    cwd: root, encoding: "utf8", timeout: 120_000,
    env: { ...process.env, TZ: "UTC", CLAI_ASSEMBLY_REPORT: output },
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Offline assembly checks failed (${result.status ?? result.signal}):\n${result.stdout.slice(-8_000)}\n${result.stderr.slice(-2_000)}`);
  }
  return readFile(output, "utf8");
}
