import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateConfig } from "../src/store/config.js";
import { rtkSessionEnv } from "../src/store/rtk-usage.js";
import { getDataDir } from "../src/store/paths.js";
import { toolRegistry } from "../src/tools/registry.js";
import { jobManager } from "../src/tools/jobs.js";
import {
  detectRtk,
  forgetRtk,
  probeRtkPath,
  RTK_EXEC_ENV,
  readRtkGain,
  rtkPathEnv,
} from "../src/tools/rtk/binary.js";
import { runRtkMaintenance, type RtkMaintenanceState } from "../src/tools/rtk/install.js";
import { prepareRtkExecution, rtkExecutionCount } from "../src/tools/rtk/rewrite.js";
import { FAKE_RTK_MARKER, installFakeRtk, type FakeRtk } from "./helpers/fake-rtk.js";

const maintenance = vi.hoisted(() => ({ current: undefined as RtkMaintenanceState | undefined }));

vi.mock("../src/tools/rtk/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/rtk/install.js")>()),
  rtkMaintenance: () => maintenance.current,
}));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const run = promisify(execFile);

const rewrites = async (rtk: FakeRtk): Promise<string[]> =>
  (await rtk.invocations()).filter((line) => line.startsWith("rewrite "));

describe.skipIf(process.platform === "win32")("rtk command rewriting", () => {
  let rtk: FakeRtk;

  beforeEach(async () => {
    rtk = await installFakeRtk();
    maintenance.current = undefined;
    forgetRtk();
    updateConfig({ rtk: true });
  });

  afterEach(async () => {
    updateConfig({ rtk: false });
    forgetRtk();
    await rtk.dispose();
  });

  it("does not consult rtk at all while compression is off", async () => {
    updateConfig({ rtk: false });
    expect(await prepareRtkExecution("git status")).toEqual({ command: "git status" });
    expect(await rtk.invocations()).toEqual([]);
  });

  it("does not count an aborted preparation", async () => {
    const sessionId = `rtk-aborted-${basename(rtk.dir)}`;
    expect(await prepareRtkExecution("git status", AbortSignal.abort(), sessionId)).toEqual({ command: "git status" });
    expect(rtkExecutionCount(sessionId)).toBe(0);
    expect((await rtk.invocations()).filter((line) => line === "git status")).toEqual([]);
  });

  it("runs the rewritten command with rtk's hook warning suppressed", async () => {
    const before = rtkExecutionCount();
    const execution = await prepareRtkExecution("git status");
    expect(execution).toEqual({ command: "rtk git status", env: { ...RTK_EXEC_ENV, ...rtkSessionEnv() }, onSpawn: expect.any(Function) });
    expect(rtkExecutionCount()).toBe(before);
  });

  it("asks rtk about the trimmed command", async () => {
    const execution = await prepareRtkExecution("  git status \n");
    expect(execution.command).toBe("rtk git status");
    expect((await rewrites(rtk)).at(-1)).toBe("rewrite git status");
  });

  it("isolates savings from other conversations and inherited RTK database settings", async () => {
    const prior = process.env.RTK_DB_PATH;
    process.env.RTK_DB_PATH = join(rtk.dir, "unrelated.db");
    try {
      for (const sessionId of ["conversation-a", "conversation-a", "conversation-b"]) {
        const execution = await prepareRtkExecution("git status", undefined, sessionId);
        await run("sh", ["-c", execution.command], { env: { ...process.env, ...execution.env } });
        execution.onSpawn?.();
      }
      expect(await readRtkGain(rtk.path, "conversation-a")).toEqual({ commands: 2, savedTokens: 200, savingsPct: 50 });
      expect(await readRtkGain(rtk.path, "conversation-b")).toEqual({ commands: 1, savedTokens: 100, savingsPct: 50 });
      expect(await readRtkGain(rtk.path, "conversation-c")).toEqual({ commands: 0, savedTokens: 0, savingsPct: 50 });
      const resumed = await prepareRtkExecution("rtk git status", undefined, "conversation-a");
      expect(resumed.env?.RTK_DB_PATH).toBe(rtkSessionEnv("conversation-a").RTK_DB_PATH);
      expect(resumed.env?.RTK_DB_PATH).not.toBe(prior);
    } finally {
      if (prior === undefined) delete process.env.RTK_DB_PATH;
      else process.env.RTK_DB_PATH = prior;
    }
  });

  it("accepts both explicit-allow (0) and ask (3) rewrites", async () => {
    expect((await prepareRtkExecution("fake-allow")).command).toBe("rtk fake-allow");
    expect((await prepareRtkExecution("git diff")).command).toBe("rtk git diff");
  });

  it.each([
    ["a command rtk has no equivalent for", "echo hello"],
    ["a command rtk denies", "fake-deny"],
    ["a rewrite identical to the input", "fake-same"],
    ["a multi-line rewrite", "fake-multiline"],
    ["an empty rewrite", "fake-silent"],
  ])("keeps the original command for %s", async (_label, command) => {
    const before = rtkExecutionCount();
    expect(await prepareRtkExecution(command)).toEqual({ command });
    expect(rtkExecutionCount()).toBe(before);
  });

  it.each([
    ["a command clai already reduces", "nmap -sV 10.0.0.1"],
    ["a privileged command", "sudo git status"],
    ["a command that needs a terminal", "ssh host uptime"],
    ["a blank command", "   "],
    ["a command with a NUL byte", "git status\0"],
    ["an oversized command", `git status ${"x".repeat(16_001)}`],
  ])("never asks rtk to rewrite %s", async (_label, command) => {
    expect(await prepareRtkExecution(command)).toEqual({ command });
    expect(await rewrites(rtk)).toEqual([]);
  });

  it("does not rewrite while rtk is being installed or updated", async () => {
    maintenance.current = { action: "update", phase: "downloading" };
    expect(await prepareRtkExecution("git status")).toEqual({ command: "git status" });
    expect(await rtk.invocations()).toEqual([]);
    maintenance.current = undefined;
    expect((await prepareRtkExecution("git status")).command).toBe("rtk git status");
  });

  it.each([
    "rtk recall 7f79db136968",
    "cd /tmp && rtk git diff --no-compact",
    "bash -c 'rtk recall 7f79db136968'",
  ])("gives a follow-up command that invokes rtk itself rtk's environment: %s", async (command) => {
    const before = rtkExecutionCount();
    expect(await prepareRtkExecution(command)).toEqual({ command, env: { ...RTK_EXEC_ENV, ...rtkSessionEnv() } });
    expect(rtkExecutionCount()).toBe(before);
  });

  it.each([
    "ls src/rtk/binary.ts",
    "cat ~/.cargo/bin/rtk-notes",
    "./node_modules/.bin/rtk --help",
    "echo mortk rtk_thing",
  ])("does not mistake %s for an rtk invocation", async (command) => {
    expect(await prepareRtkExecution(command)).toEqual({ command });
  });

  it("forgets a vanished binary and runs the command unmodified", async () => {
    expect((await detectRtk(true)).state).toBe("ready");
    await rm(rtk.path);
    expect(await prepareRtkExecution("git status")).toEqual({ command: "git status" });
    const status = await detectRtk();
    expect(status.state === "ready" ? status.path : undefined).not.toBe(rtk.path);
  });

  it("re-detects rtk once an install or update has finished", async () => {
    expect((await detectRtk(true)).state).toBe("ready");
    expect(await runRtkMaintenance("install")).toMatchObject({ ok: true, action: "install" });
    await rm(rtk.path);
    const status = await detectRtk();
    expect(status.state === "ready" ? status.path : undefined).not.toBe(rtk.path);
  });
});

describe.skipIf(process.platform === "win32")("rtk installed outside PATH", () => {
  const saved = { home: process.env.HOME, path: process.env.PATH };
  const dirs: string[] = [];
  let fake: FakeRtk;

  beforeEach(async () => {
    fake = await installFakeRtk({ onPath: false });
    const home = await mkdtemp(join(tmpdir(), "clai-rtk-home-"));
    const impostors = await mkdtemp(join(tmpdir(), "clai-rtk-impostor-"));
    dirs.push(home, impostors);
    await mkdir(join(home, ".cargo", "bin"), { recursive: true });
    await copyFile(fake.path, join(home, ".cargo", "bin", "rtk"));
    await chmod(join(home, ".cargo", "bin", "rtk"), 0o755);
    await writeFile(join(impostors, "rtk"), "#!/bin/sh\necho impostor\n");
    await chmod(join(impostors, "rtk"), 0o755);
    process.env.HOME = home;
    process.env.PATH = `${impostors}${delimiter}${saved.path ?? ""}`;
    maintenance.current = undefined;
    forgetRtk();
    updateConfig({ rtk: true });
  });

  afterEach(async () => {
    updateConfig({ rtk: false });
    forgetRtk();
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    await fake.dispose();
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("runs rewritten commands through the verified rtk instead of the impostor shadowing it", async () => {
    const execution = await prepareRtkExecution("git status");
    expect(execution.command).toBe("rtk git status");
    const { stdout } = await run("sh", ["-c", execution.command], {
      env: { ...process.env, ...execution.env },
    });
    expect(stdout).toContain(`${FAKE_RTK_MARKER} git status`);
  });

  it("keeps background execution on the verified binary instead of a PATH impostor", async () => {
    const sessionId = `rtk-offpath-${basename(fake.dir)}`;
    const started = await toolRegistry["shell.exec"]!(
      { command: "git status", background: "always" },
      { sessionId },
    );
    const id = started.backgroundJob?.id;
    if (!id) throw new Error(started.output);
    const result = await jobManager.waitForJob(id, { timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`${FAKE_RTK_MARKER} git status`);
    expect(result.output).not.toContain("impostor");
    expect(rtkExecutionCount(sessionId)).toBe(1);
  });

  it("keeps rtk reachable for the follow-up commands its own output suggests", async () => {
    const result = await toolRegistry["shell.exec"]!({ command: "rtk --version" });
    expect(result.ok).toBe(true);
    expect(result.output).toBe("rtk 0.50.0");
  });

  it("leaves the environment of unrelated commands untouched", async () => {
    expect(await prepareRtkExecution("echo hello")).toEqual({ command: "echo hello" });
  });
});

describe.skipIf(process.platform === "win32")("rtk binary verification", () => {
  const dirs: string[] = [];
  const rtks: FakeRtk[] = [];

  const executable = async (body: string): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "clai-rtk-candidate-"));
    dirs.push(dir);
    const path = join(dir, "rtk");
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  };

  afterEach(async () => {
    forgetRtk();
    await Promise.all(rtks.splice(0).map((fake) => fake.dispose()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("accepts a binary that answers rtk rewrite", async () => {
    const rtk = await installFakeRtk({ onPath: false });
    rtks.push(rtk);
    const status = await probeRtkPath(rtk.path);
    expect(status).toMatchObject({ state: "ready", path: rtk.path, version: "0.50.0" });
  });

  it("rejects a same-named binary that is not rtk-ai/rtk", async () => {
    const impostor = await executable('echo "rtk 1.2.3"; exit 0');
    expect(await probeRtkPath(impostor)).toEqual({
      state: "incompatible",
      path: impostor,
      version: "1.2.3",
    });
    const unrelated = await executable('echo "something else"; exit 0');
    expect(await probeRtkPath(unrelated)).toMatchObject({ state: "incompatible", path: unrelated });
  });

  it("reports a missing binary", async () => {
    expect(await probeRtkPath(join(tmpdir(), "clai-rtk-does-not-exist"))).toEqual({ state: "missing" });
  });

  it("exposes a verified binary that is off PATH through a private shim", async () => {
    const rtk = await installFakeRtk({ onPath: false });
    rtks.push(rtk);
    const status = await probeRtkPath(rtk.path);
    if (status.state !== "ready" || !status.pathEntry) throw new Error("expected a shimmed ready status");
    expect(status.pathEntry.position).toBe("prepend");
    expect(status.pathEntry.dir.startsWith(getDataDir())).toBe(true);
    expect(await readlink(join(status.pathEntry.dir, "rtk"))).toBe(rtk.path);

    const { stdout } = await run("sh", ["-c", "rtk git status"], {
      env: { ...process.env, PATH: rtkPathEnv(status.pathEntry) },
    });
    expect(stdout).toContain(`${FAKE_RTK_MARKER} git status`);
    expect(await rtk.invocations()).toContain("git status");
  });
});

describe.skipIf(process.platform === "win32")("shell.exec with rtk compression", () => {
  let rtk: FakeRtk;
  let workdir: string;

  const exec = (command: string) => toolRegistry["shell.exec"]!({ command, cwd: workdir });

  beforeEach(async () => {
    rtk = await installFakeRtk();
    maintenance.current = undefined;
    forgetRtk();
    workdir = await mkdtemp(join(tmpdir(), "clai-rtk-shell-"));
    await writeFile(join(workdir, "notes.txt"), "alpha\nbeta\n");
    await writeFile(join(workdir, "other.txt"), "alpha\ngamma\n");
    updateConfig({ rtk: true });
  });

  afterEach(async () => {
    updateConfig({ rtk: false });
    forgetRtk();
    await rtk.dispose();
    await rm(workdir, { recursive: true, force: true });
  });

  it("executes the rewritten command and passes rtk's environment to it", async () => {
    const result = await exec("git status");
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`${FAKE_RTK_MARKER} git status`);
    expect(result.output).toContain("hook-warning=1");
  });

  it("runs commands rtk declines exactly as written", async () => {
    const result = await exec("echo hello");
    expect(result.output).toBe("hello");
    expect(result.output).not.toContain(FAKE_RTK_MARKER);
  });

  it("keeps grep's no-match exit a non-error when the command was rewritten", async () => {
    const result = await exec("grep zzz notes.txt");
    expect(result.output).toContain(`${FAKE_RTK_MARKER} grep`);
    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("no matching lines");
  });

  it("keeps diff's files-differ exit a non-error when the command was rewritten", async () => {
    const result = await exec("diff notes.txt other.txt");
    expect(result.output).toContain(`${FAKE_RTK_MARKER} diff`);
    expect(result.exitCode).toBe(1);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("files differ");
  });

  it("still reports real failures of a rewritten command", async () => {
    const result = await exec("grep alpha missing.txt");
    expect(result.output).toContain(`${FAKE_RTK_MARKER} grep`);
    expect(result.exitCode).toBe(2);
    expect(result.ok).toBe(false);
  });

  it("names the output artifact after the requested command, not rtk", async () => {
    const result = await exec("grep alpha notes.txt");
    expect(result.output).toContain(`${FAKE_RTK_MARKER} grep`);
    expect(result.outputPath).toBeDefined();
    expect(basename(result.outputPath!)).toMatch(/-grep\.txt$/);
  });

  it("does not count a command that fails to launch", async () => {
    const before = rtkExecutionCount();
    const result = await toolRegistry["shell.exec"]!({ command: "git status", cwd: join(workdir, "missing") });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("INVALID_CWD");
    expect(rtkExecutionCount()).toBe(before);
  });

  it("does not count a background command with an invalid working directory", async () => {
    const sessionId = `rtk-invalid-job-${basename(workdir)}`;
    const result = await toolRegistry["shell.exec"]!(
      { command: "git status", cwd: join(workdir, "missing"), background: "always" },
      { sessionId },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain("INVALID_CWD");
    expect(rtkExecutionCount(sessionId)).toBe(0);
    expect((await rtk.invocations()).filter((line) => line === "git status")).toEqual([]);
  });

  it.each([{ background: "always" }, { responder: true }])("does not launch or count an expired authorized job: %j", async (mode) => {
    const sessionId = `rtk-expired-${basename(workdir)}`;
    const result = await toolRegistry["shell.exec"]!(
      { command: "git status", cwd: workdir, ...mode },
      { sessionId, engagementAuthorization: { target: "example.com", expiresAt: "2000-01-01T00:00:00.000Z" } },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/authorization.*expired/i);
    expect(rtkExecutionCount(sessionId)).toBe(0);
    expect((await rtk.invocations()).filter((line) => line === "git status")).toEqual([]);
  });

  it("counts executions against their owning conversation rather than the process", async () => {
    const sessionId = `rtk-session-${basename(workdir)}`;
    expect(rtkExecutionCount(sessionId)).toBe(0);
    await toolRegistry["shell.exec"]!({ command: "git status", cwd: workdir }, { sessionId });
    expect(rtkExecutionCount(sessionId)).toBe(1);
    expect(rtkExecutionCount(`${sessionId}-new`)).toBe(0);
    expect(rtkExecutionCount(sessionId)).toBe(1);
  });

  it.each([
    { background: "always" },
    { responder: true },
  ])("compresses explicitly delegated commands and preserves their receipts: %j", async (mode) => {
    const sessionId = `rtk-job-${basename(workdir)}`;
    const started = await toolRegistry["shell.exec"]!(
      { command: "git status", cwd: workdir, ...mode },
      { sessionId, taskId: "t4", delegationId: sessionId },
    );
    const id = started.backgroundJob?.id;
    if (!id) throw new Error(started.output);
    const result = await jobManager.waitForJob(id, { timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.output).toContain(`${FAKE_RTK_MARKER} git status`);
    expect(result.output).toContain("hook-warning=1");
    expect(jobManager.getJob(id)).toMatchObject({
      commandDisplay: "git status",
      ownerSessionId: sessionId,
      taskId: "t4",
      responder: "responder" in mode && mode.responder === true,
    });
    expect(rtkExecutionCount(sessionId)).toBe(1);
    const duplicate = await toolRegistry["shell.exec"]!(
      { command: "git status", cwd: workdir, ...mode },
      { sessionId, taskId: "t4", delegationId: sessionId },
    );
    expect(duplicate.backgroundJob?.id).toBe(id);
    expect(rtkExecutionCount(sessionId)).toBe(1);
  });

  it("behaves identically to the unmodified run apart from the compressed body", async () => {
    const results = new Map<string, Awaited<ReturnType<typeof exec>>>();
    for (const enabled of [false, true]) {
      updateConfig({ rtk: enabled });
      for (const command of ["grep zzz notes.txt", "grep alpha notes.txt", "grep alpha missing.txt"]) {
        results.set(`${enabled}:${command}`, await exec(command));
      }
    }
    for (const command of ["grep zzz notes.txt", "grep alpha notes.txt", "grep alpha missing.txt"]) {
      const plain = results.get(`false:${command}`)!;
      const compressed = results.get(`true:${command}`)!;
      expect(compressed.ok).toBe(plain.ok);
      expect(compressed.exitCode).toBe(plain.exitCode);
      expect(compressed.output).toContain(plain.output);
    }
  });
});
