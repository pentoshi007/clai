import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { performUpdate, type PerformUpdateOptions } from "../src/commands/update-install.js";
import * as commands from "../src/commands/update/process.js";
import { sourceCleanupWorker } from "../src/commands/update/source-worker.js";

const roots: string[] = [];
function git(root: string, args: string[]): string {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function sourceVersion(root: string): string {
  return execFileSync(process.execPath, [join(root, "dist", "index.js"), "--version"], { encoding: "utf8" }).trim();
}
function packageFiles(root: string, version: string, buildFails = false, installationFails = false): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@pentoshi/clai", version, type: "module", scripts: { build: "node build.mjs" } }));
  writeFileSync(join(root, "package-lock.json"), JSON.stringify({ name: "@pentoshi/clai", version, lockfileVersion: 3, packages: { "": { name: "@pentoshi/clai", version } } }));
  const code = installationFails ? `console.log(process.argv[1].includes('.clai-update-')?'${version}':'0.0.0')` : `console.log('${version}')`;
  writeFileSync(join(root, "build.mjs"), buildFails ? "process.exit(1)" : `import {mkdirSync,writeFileSync} from 'node:fs';mkdirSync('node_modules',{recursive:true});mkdirSync('dist',{recursive:true});writeFileSync('node_modules/fixture','${version}');writeFileSync('dist/index.js',${JSON.stringify(code)});`);
}
function fixture(buildFails = false, installationFails = false) {
  const temp = mkdtempSync(join(tmpdir(), "clai-source-update-")); roots.push(temp);
  const upstream = join(temp, "upstream"); mkdirSync(upstream);
  git(upstream, ["init", "-b", "main"]);
  git(upstream, ["config", "user.name", "Updater fixture"]);
  git(upstream, ["config", "user.email", "fixture@example.test"]);
  writeFileSync(join(upstream, ".gitignore"), "node_modules\ndist\n");
  packageFiles(upstream, "4.14.4");
  git(upstream, ["add", "."]); git(upstream, ["commit", "-m", "old"]);
  const root = join(temp, "active");
  execFileSync("git", ["clone", "--quiet", upstream, root], { stdio: "pipe" });
  git(root, ["config", "user.name", "Updater fixture"]); git(root, ["config", "user.email", "fixture@example.test"]);
  execFileSync(process.execPath, ["build.mjs"], { cwd: root, stdio: "pipe" });
  const head = git(root, ["rev-parse", "HEAD"]);
  packageFiles(upstream, "9.9.9", buildFails, installationFails);
  git(upstream, ["add", "."]); git(upstream, ["commit", "-m", "new"]);
  const config = join(temp, "user-config.json"); writeFileSync(config, '{"fixture":"preserve"}');
  const options: PerformUpdateOptions = { method: { type: "dev", detail: "fixture", packageRoot: root, runtimePath: process.execPath }, version: "9.9.9", log: () => {}, stdio: "pipe" };
  return { root, head, config, options };
}
function trustedFixtureTransport(): void {
  const run = commands.runUpdateCommand;
  vi.spyOn(commands, "runUpdateCommand").mockImplementation((command, options) => {
    if (command.file === "git" && command.args.join(" ") === "remote get-url origin") return Promise.resolve("https://github.com/pentoshi007/clai.git");
    return run(command, options);
  });
}
function kept(root: string, head: string): void {
  expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
  expect(sourceVersion(root)).toBe("4.14.4");
  expect(readFileSync(join(root, "node_modules", "fixture"), "utf8")).toBe("4.14.4");
  expect(readdirSync(root).some((name) => name.startsWith(".clai-update-"))).toBe(false);
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("automatic source updates with real git/npm/build/runtime operations", () => {
  it("builds separately, fast-forwards, promotes and verifies without touching user configuration", async () => {
    const { root, head, config, options } = fixture(); trustedFixtureTransport();
    const result = await performUpdate(options);
    expect(result).toMatchObject({ ok: true, outcome: "applied", method: "dev", installedVersion: "9.9.9" });
    expect(git(root, ["rev-parse", "HEAD"])).not.toBe(head);
    expect(sourceVersion(root)).toBe("9.9.9");
    expect(readFileSync(config, "utf8")).toBe('{"fixture":"preserve"}');
    expect(git(root, ["status", "--porcelain"])).toBe("");
    expect(git(root, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
  });
  it("keeps the checkout, dependencies and distribution when the isolated build fails", async () => {
    const { root, head, options } = fixture(true); trustedFixtureTransport();
    await expect(performUpdate(options)).rejects.toThrow(/status 1/);
    kept(root, head);
  });
  it("restores tracked files and old dependencies if installed runtime proof fails", async () => {
    const { root, head, options } = fixture(false, true); trustedFixtureTransport();
    await expect(performUpdate(options)).rejects.toThrow(/runtime verification failed/);
    kept(root, head);
    expect(git(root, ["status", "--porcelain"])).toBe("");
  });
  it("refuses dirty checkouts without modifying them", async () => {
    const { root, head, options } = fixture();
    const file = join(root, "package.json"); const changed = readFileSync(file, "utf8") + "\n"; writeFileSync(file, changed);
    await expect(performUpdate(options)).rejects.toThrow(/local changes/);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(file, "utf8")).toBe(changed);
  });
  it("refuses custom upstreams", async () => {
    const { root, head, options } = fixture();
    await expect(performUpdate(options)).rejects.toThrow(/official clai upstream/);
    kept(root, head);
  });
  it("refuses divergent local commits instead of discarding or merging them", async () => {
    const { root, options } = fixture(); trustedFixtureTransport();
    writeFileSync(join(root, "local-file"), "keep"); git(root, ["add", "."]); git(root, ["commit", "-m", "local"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    await expect(performUpdate(options)).rejects.toThrow(/divergent commits/);
    kept(root, head);
    expect(readFileSync(join(root, "local-file"), "utf8")).toBe("keep");
  });
  it("cancels before build application and removes only its own staging worktree", async () => {
    const { root, head, options } = fixture(); trustedFixtureTransport();
    const controller = new AbortController();
    await expect(performUpdate({ ...options, signal: controller.signal, onProgress: () => controller.abort() })).rejects.toThrow(/cancelled/);
    kept(root, head);
    expect(existsSync(join(root, ".git"))).toBe(true);
  });
});

describe("abandoned source stage cleanup", () => {
  it.each([false, true])("removes only its own worktree unless recovery files exist (%s)", async (recovery) => {
    const { root, head } = fixture();
    const stage = mkdtempSync(join(root, ".clai-update-"));
    const worktree = join(stage, "worktree");
    git(root, ["worktree", "add", "--detach", worktree, "HEAD"]);
    const payload = join(stage, "task.json"); writeFileSync(payload, JSON.stringify({ root, stage, worktree }));
    if (recovery) writeFileSync(join(stage, "recovery"), "preserve");
    await commands.runUpdateCommand({ file: process.execPath, args: ["--input-type=module", "-e", sourceCleanupWorker, payload] });
    expect(existsSync(stage)).toBe(recovery);
    expect(git(root, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(recovery ? 2 : 1);
    expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(sourceVersion(root)).toBe("4.14.4");
  });
  it("does nothing after the apply worker has already removed its stage", async () => {
    const { root, head } = fixture();
    const payload = join(root, ".clai-update-removed", "task.json");
    await commands.runUpdateCommand({ file: process.execPath, args: ["--input-type=module", "-e", sourceCleanupWorker, payload] });
    expect(git(root, ["rev-parse", "HEAD"])).toBe(head);
    expect(sourceVersion(root)).toBe("4.14.4");
  });
});
