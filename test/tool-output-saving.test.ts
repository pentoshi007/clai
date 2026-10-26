import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatToolContext, saveToolOutput } from "../src/agent/tool-output-formatting.js";
import { getConfig, updateConfig } from "../src/store/config.js";
import { store } from "../src/store/config/endpoints.js";
import { shellExec, spawnArgv } from "../src/tools/shell.js";

let directory: string;
let artifacts: string;
let script: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "clai-output-saving-"));
  artifacts = join(directory, "outputs");
  script = join(directory, "command.cjs");
  await writeFile(script, 'process.stdout.write("OUTPUT_SAVING_PROBE\\n")');
  vi.stubEnv("CLAI_ARTIFACT_DIR", artifacts);
  updateConfig({ saveToolOutputs: undefined, privateMode: false });
});

afterEach(async () => {
  store.delete("saveToolOutputs");
  updateConfig({ privateMode: false });
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

const runners = {
  shell: () => shellExec({ command: `"${process.execPath}" "${script}"`, timeoutMs: 5_000 }),
  argv: () => spawnArgv({ command: process.execPath, argv: [script], timeoutMs: 5_000 }),
  snapshot: async () => ({
    ok: true,
    output: "OUTPUT_SAVING_PROBE",
    outputPath: await saveToolOutput({ name: "fs.read", args: {} }, "OUTPUT_SAVING_PROBE"),
  }),
};

describe.each(Object.entries(runners))("%s automatic output saving", (_name, run) => {
  it("defaults off without creating an output directory or advertising a path", async () => {
    expect(getConfig().saveToolOutputs).toBe(false);
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.output).toContain("OUTPUT_SAVING_PROBE");
    expect(result.outputPath).toBeUndefined();
    expect(existsSync(artifacts)).toBe(false);
    expect(formatToolContext({ name: "shell.exec", args: {} }, result)).not.toMatch(/saved to|Full artifact/);
  });

  it("writes a readable artifact only after opting in", async () => {
    updateConfig({ saveToolOutputs: true });
    const result = await run();
    expect(result.ok).toBe(true);
    expect(result.outputPath).toBeTruthy();
    expect(readFileSync(result.outputPath!, "utf8")).toContain("OUTPUT_SAVING_PROBE");
    expect(formatToolContext({ name: "shell.exec", args: {} }, result)).toContain(result.outputPath);
  });

  it("stops saving subsequent commands when switched back off", async () => {
    updateConfig({ saveToolOutputs: true });
    expect((await run()).outputPath).toBeTruthy();
    await rm(artifacts, { recursive: true, force: true });
    updateConfig({ saveToolOutputs: false });
    expect((await run()).outputPath).toBeUndefined();
    expect(existsSync(artifacts)).toBe(false);
  });

  it("honors private mode even when saving is enabled", async () => {
    updateConfig({ saveToolOutputs: true, privateMode: true });
    expect((await run()).outputPath).toBeUndefined();
    expect(existsSync(artifacts)).toBe(false);
  });
});

it("preserves an explicitly requested capture while automatic saving is off", async () => {
  const outputPath = join(directory, "explicit.txt");
  const result = await spawnArgv({ command: process.execPath, argv: [script], artifactPath: outputPath });
  expect(result.outputPath).toBe(outputPath);
  expect(readFileSync(outputPath, "utf8")).toContain("OUTPUT_SAVING_PROBE");
});

it("keeps noArtifact authoritative when automatic saving is enabled", async () => {
  updateConfig({ saveToolOutputs: true });
  const result = await spawnArgv({ command: process.execPath, argv: [script], noArtifact: true });
  expect(result.outputPath).toBeUndefined();
  expect(existsSync(artifacts)).toBe(false);
});
