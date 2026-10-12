import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PACKAGE_NAME, type PerformUpdateOptions, type UpdateInstallResult } from "./installers.js";
import { runUpdateCommand, throwIfCancelled } from "./process.js";
import { sourceApplyWorker, sourceCleanupWorker } from "./source-worker.js";
import { compareVersions, releaseVersion, verifyCommand } from "./verification.js";
import { stageWindowsUpdate } from "./windows-stage.js";

export async function installSourceUpdate(options: PerformUpdateOptions): Promise<UpdateInstallResult> {
  const root = options.method.packageRoot;
  const runtime = options.method.runtimePath;
  if (!root || !runtime) throw new Error("cannot identify the active source checkout and runtime");
  const git = (args: readonly string[]): Promise<string> => runUpdateCommand({ file: "git", args, cwd: root, env: { GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes" } }, { signal: options.signal, timeoutMs: 120_000 });
  throwIfCancelled(options.signal);
  if (await git(["status", "--porcelain"])) throw new Error("source checkout has local changes; commit or stash them before updating. Nothing was overwritten");
  const head = await git(["rev-parse", "HEAD"]);
  const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const remote = await git(["config", "--get", `branch.${branch}.remote`]);
  const ref = await git(["config", "--get", `branch.${branch}.merge`]);
  const url = await git(["remote", "get-url", remote]);
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)pentoshi007\/clai(?:\.git)?\/?$/i.test(url)) {
    throw new Error("source checkout must track the official clai upstream; custom remotes are not changed automatically");
  }
  if (!ref.startsWith("refs/heads/")) throw new Error("source checkout has no upstream branch; configure tracking before updating");
  options.log?.("Fetching the tracked source upstream…");
  await git(["fetch", "--no-tags", remote, ref]);
  const commit = await git(["rev-parse", "FETCH_HEAD"]);
  try { await git(["merge-base", "--is-ancestor", head, commit]); }
  catch { throw new Error("source checkout has local or divergent commits; update requires a safe fast-forward. Nothing was overwritten"); }
  const stage = mkdtempSync(join(root, ".clai-update-"));
  const worktree = join(stage, "worktree");
  let pending = false;
  try {
    await git(["worktree", "add", "--detach", worktree, commit]);
    const manifest: unknown = JSON.parse(readFileSync(join(worktree, "package.json"), "utf8"));
    if (!manifest || typeof manifest !== "object" || !("name" in manifest) || manifest.name !== PACKAGE_NAME || !("version" in manifest)) throw new Error("upstream is not a clai source checkout");
    const version = releaseVersion(manifest.version);
    if (!version || compareVersions(version, options.version) < 0) throw new Error(`tracked source upstream has not reached v${options.version}; existing checkout was kept`);
    options.onProgress?.({ phase: "installing", detail: "building isolated source worktree" });
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const runOptions = { signal: options.signal, log: options.log, timeoutMs: 600_000 };
    await runUpdateCommand({ file: npm, args: ["ci", "--no-audit", "--no-fund"], cwd: worktree }, runOptions);
    await runUpdateCommand({ file: npm, args: ["run", "build", "--silent"], cwd: worktree }, runOptions);
    options.onProgress?.({ phase: "verifying" });
    await verifyCommand({ file: runtime, args: [join(worktree, "dist", "index.js"), "--version"] }, version, { signal: options.signal });
    const worker = join(stage, "apply-source.mjs");
    const payload = join(stage, "task.json");
    writeFileSync(worker, sourceApplyWorker);
    writeFileSync(payload, JSON.stringify({ root, stage, worktree, head, commit, runtime, version }));
    const application = { file: runtime, args: [worker, payload] };
    const verification = { file: runtime, args: [join(root, "dist", "index.js"), "--version"] };
    throwIfCancelled(options.signal);
    if (process.platform === "win32") {
      const cleanup = { file: runtime, args: ["--input-type=module", "-e", sourceCleanupWorker, payload] };
      const statusFile = await stageWindowsUpdate({ kind: "commands", commands: [application], verification, version, allowNewer: false, cleanup }, { signal: options.signal, ...(options.lockFile ? { lockFile: options.lockFile, lockToken: options.lockToken } : {}) });
      pending = true;
      return { ok: true, method: "dev", outcome: "staged", needsRestart: true, statusFile, message: `source update built and staged; close clai to apply it. Result: ${statusFile}` };
    }
    await runUpdateCommand(application, { timeoutMs: 120_000, log: options.log });
    const installedVersion = await verifyCommand(verification, version);
    return { ok: true, method: "dev", outcome: "applied", installedVersion, needsRestart: true, message: `source checkout fast-forwarded, rebuilt and verified at v${installedVersion}` };
  } finally {
    if (!pending && !existsSync(join(stage, "recovery"))) {
      if (existsSync(worktree)) await runUpdateCommand({ file: "git", args: ["worktree", "remove", "--force", worktree], cwd: root }, { timeoutMs: 30_000 }).catch(() => {});
      rmSync(stage, { recursive: true, force: true });
    }
  }
}
