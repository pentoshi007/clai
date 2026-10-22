import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findBunExecutable } from "../src/os/bun-runtime.js";

const storage = vi.hoisted(() => ({
  failure: undefined as "open" | "write" | "flush" | undefined,
  code: "EDQUOT",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      if (!storage.failure) return actual.createWriteStream(...args);
      const failure = storage.failure;
      const error = Object.assign(new Error("Storage unavailable"), { code: storage.code });
      const stream = new Writable({
        write(_chunk, _encoding, callback) {
          callback(failure === "write" ? error : undefined);
        },
        final(callback) {
          callback(failure === "flush" ? error : undefined);
        },
      });
      if (failure === "open") queueMicrotask(() => stream.destroy(error));
      return stream;
    },
  };
});

import { shellExec, spawnArgv } from "../src/tools/shell.js";

const directories: string[] = [];

afterEach(async () => {
  storage.failure = undefined;
  storage.code = "EDQUOT";
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function artifactPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "clai-artifact-failure-"));
  directories.push(dir);
  return join(dir, "output.txt");
}

const runners = {
  shell: async (path: string, source: string) => {
    const script = join(dirname(path), "command.cjs");
    await writeFile(script, source);
    return shellExec({
      command: `"${process.execPath}" "${script}"`,
      artifactPath: path,
      timeoutMs: 2_000,
    });
  },
  argv: (path: string, source: string) => spawnArgv({
    command: process.execPath,
    argv: ["-e", source],
    artifactPath: path,
    timeoutMs: 2_000,
  }),
};

describe.each(Object.entries(runners))("%s output artifacts", (_name, run) => {
  it.each(["open", "write", "flush"] as const)(
    "preserves command output when storage fails during %s",
    async (failure) => {
      const path = await artifactPath();
      storage.failure = failure;
      const result = await run(path, 'console.log("before"); setTimeout(() => console.log("after"), 30)');
      expect(result).toMatchObject({ ok: true, exitCode: 0, truncated: false });
      expect(result.output).toContain("before\nafter");
      expect(result.output).toContain("Full output could not be saved (EDQUOT)");
      expect(result.warning).toContain("Storage quota exceeded (EDQUOT)");
      expect(result.warning).toContain("TMPDIR");
      expect(result.outputPath).toBeUndefined();
    },
  );

  it("preserves a command failure when the output disk is full", async () => {
    storage.failure = "write";
    storage.code = "ENOSPC";
    const result = await run(await artifactPath(), 'console.log("command failed"); process.exitCode = 3');
    expect(result).toMatchObject({ ok: false, exitCode: 3 });
    expect(result.output).toContain("command failed");
    expect(result.output).toContain("Full output could not be saved (ENOSPC)");
    expect(result.outputPath).toBeUndefined();
  });

  it("completes an empty command after an early artifact error", async () => {
    storage.failure = "open";
    const result = await run(await artifactPath(), 'setTimeout(() => {}, 30)');
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.output).toContain("Full output could not be saved (EDQUOT)");
    expect(result.outputPath).toBeUndefined();
  });

  it("reports an unwritable artifact destination without failing the command", async () => {
    const path = await artifactPath();
    await mkdir(path);
    const result = await run(path, 'console.log("still works")');
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.output).toContain("still works");
    expect(result.output).toContain("Full output could not be saved");
    expect(result.outputPath).toBeUndefined();
  });

  it("flushes a working artifact before advertising its path", async () => {
    const path = await artifactPath();
    const result = await run(path, 'console.log("saved output")');
    expect(result).toMatchObject({ ok: true, exitCode: 0, outputPath: path });
    expect(await readFile(path, "utf8")).toBe("saved output\n");
    expect(result.output).not.toContain("could not be saved");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("preserves a file that cannot be opened for capture", async () => {
    const path = await artifactPath();
    await writeFile(path, "existing content", { mode: 0o600 });
    await chmod(path, 0o400);
    const result = await run(path, 'console.log("still works")');
    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.output).toContain("Full output could not be saved (EACCES)");
    expect(result.outputPath).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe("existing content");
  });
});

const bun = findBunExecutable();

it.skipIf(!bun || !existsSync("/dev/full"))("handles real asynchronous write failures under Bun", () => {
  const module = fileURLToPath(new URL("../src/tools/shell.ts", import.meta.url));
  const source = `
    import { shellExec, spawnArgv } from ${JSON.stringify(module)};
    const results = [
      await shellExec({ command: "printf survived", artifactPath: "/dev/full", timeoutMs: 2000 }),
      await spawnArgv({ command: "printf", argv: ["survived"], artifactPath: "/dev/full", timeoutMs: 2000 }),
    ];
    console.log(JSON.stringify(results));
  `;
  const result = spawnSync(bun!, ["-e", source], { encoding: "utf8", timeout: 8_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  for (const tool of JSON.parse(result.stdout)) {
    expect(tool).toMatchObject({ ok: true, exitCode: 0 });
    expect(tool.output).toContain("survived");
    expect(tool.output).toContain("Full output could not be saved (ENOSPC)");
    expect(tool.outputPath).toBeUndefined();
  }
}, 10_000);
