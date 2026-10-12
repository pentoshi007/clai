import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentPlatformTarget, detectInstallMethod, performUpdate, type InstallMethod } from "../src/commands/update-install.js";
import { acquireUpdateLock } from "../src/commands/update/lock.js";
import { managerUpdateCommands } from "../src/commands/update/package-managers.js";
import { runUpdateCommand, windowsCommand } from "../src/commands/update/process.js";
import { compareVersions, verifyCommand } from "../src/commands/update/verification.js";
import { windowsUpdateScript } from "../src/commands/update/windows-stage.js";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "clai-update-execution-"));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function method(type: InstallMethod["type"], prefix = "/active", scope: "global" | "local" = "global"): InstallMethod {
  return { type, detail: "fixture", prefix, scope, packageRoot: `${prefix}/node_modules/@pentoshi/clai`, runtimePath: process.execPath };
}

describe("targeted manager commands", () => {
  it.each(["darwin", "linux", "win32"] as const)("pins npm to the active prefix on %s", (platform) => {
    const command = managerUpdateCommands(method("npm"), "9.9.9", platform)[0]!;
    expect(command.args).toContain("@pentoshi/clai@9.9.9");
    expect(command.args.slice(command.args.indexOf("--prefix"), command.args.indexOf("--prefix") + 2)).toEqual(["--prefix", "/active"]);
    expect(command.cwd).toBe("/active");
    expect(command.file).toBe(platform === "win32" ? "npm.cmd" : "npm");
  });
  it("never promotes a local npm package into a global install", () => {
    expect(managerUpdateCommands(method("npm", "/project", "local"), "9.9.9")[0]!.args).not.toContain("--global");
  });
  it("pins standard global Bun and binds both global directories", () => {
    const command = managerUpdateCommands(method("bun", "/custom/.bun/install/global"), "9.9.9", "linux")[0]!;
    expect(command.args).toEqual(["add", "--global", "--exact", "@pentoshi/clai@9.9.9"]);
    expect(command.env).toEqual({ BUN_INSTALL_GLOBAL_DIR: "/custom/.bun/install/global", BUN_INSTALL_BIN: "/custom/.bun/bin" });
  });
  it("updates a custom Bun global manifest without rewriting a different global bin", () => {
    const command = managerUpdateCommands(method("bun", "/custom/global-packages"), "9.9.9")[0]!;
    expect(command.cwd).toBe("/custom/global-packages");
    expect(command.args).not.toContain("--global");
  });
  it("targets the legacy pnpm global directory", () => {
    const command = managerUpdateCommands(method("pnpm", "/home/u/pnpm/global/5"), "9.9.9", "linux")[0]!;
    expect(command.args).toEqual(["add", "--global", "--global-dir", "/home/u/pnpm/global", "@pentoshi/clai@9.9.9"]);
  });
  it("preserves pnpm v11 isolated groups rather than creating a new global bundle", () => {
    const detected = detectInstallMethod({ argv1: "/home/u/tools/global/v11/group/node_modules/.pnpm/@pentoshi+clai@4.14.4/node_modules/@pentoshi/clai/dist/index.js", execPath: "/usr/bin/node", home: "/home/u", platform: "linux" });
    expect(detected).toMatchObject({ type: "pnpm", scope: "global", prefix: "/home/u/tools/global/v11/group", packageRoot: "/home/u/tools/global/v11/group/node_modules/@pentoshi/clai" });
    const command = managerUpdateCommands(detected, "9.9.9", "linux")[0]!;
    expect(command.args[0]).toBe("add");
    expect(command.args.at(-1)).toBe("@pentoshi/clai@9.9.9");
    expect(command.env?.PNPM_HOME).toBe("/home/u/tools");
  });
  it("pins Yarn in the active manifest without guessing its separate global bin prefix", () => {
    expect(managerUpdateCommands(method("yarn", "/home/u/.config/yarn/global"), "9.9.9")[0]).toMatchObject({ cwd: "/home/u/.config/yarn/global", args: ["--cwd", "/home/u/.config/yarn/global", "add", "--exact", "@pentoshi/clai@9.9.9"] });
  });
  it("refreshes Homebrew and uses that installation's brew executable", () => {
    const detected = detectInstallMethod({ argv1: "/opt/homebrew/bin/clai", execPath: "/opt/homebrew/Cellar/clai/4.14.4/bin/clai", home: "/Users/u", platform: "darwin", brewPrefix: "/opt/homebrew/Cellar/clai/4.14.4" });
    expect(detected.executablePath).toBe("/opt/homebrew/opt/clai/bin/clai");
    expect(managerUpdateCommands(detected, "9.9.9").map((command) => [command.file, command.args])).toEqual([["/opt/homebrew/bin/brew", ["update"]], ["/opt/homebrew/bin/brew", ["upgrade", "pentoshi007/clai/clai"]]]);
  });
  it("refreshes Scoop's manifests and targets the owning global root", () => {
    const commands = managerUpdateCommands({ type: "scoop", detail: "fixture", prefix: "C:\\ProgramData\\scoop", managerPath: "C:\\Users\\u\\scoop\\apps\\scoop\\current\\bin\\scoop.ps1", scope: "global" }, "9.9.9", "win32");
    expect(commands.map((command) => command.args)).toEqual([["update"], ["update", "clai", "--global"]]);
    expect(commands[1]?.env?.SCOOP_GLOBAL).toBe("C:\\ProgramData\\scoop");
  });
  it("refuses to guess a missing prefix", () => {
    expect(() => managerUpdateCommands({ type: "npm", detail: "unknown root" }, "9.9.9")).toThrow(/safely target/);
  });
  it("quotes PowerShell scripts literally and refuses unsafe command-wrapper interpolation", () => {
    const command = windowsCommand({ file: "C:\\a b\\scoop.ps1", args: ["install", "C:\\name's &%PATH%\\path"] });
    expect(command.file).toBe("powershell.exe");
    expect(command.args.at(-1)).toContain("'C:\\name''s &%PATH%\\path'");
    expect(() => windowsCommand({ file: "npm.cmd", args: ["bad\nargument"] })).toThrow(/invalid/);
    expect(() => windowsCommand({ file: "npm.cmd", args: ["C:\\name's &%PATH%\\path"] })).toThrow(/cannot safely pass/);
    expect(() => windowsCommand({ file: "C:\\%PREFIX%\\clai.cmd", args: ["--version"] })).toThrow(/cannot safely pass/);
    expect(windowsCommand({ file: "C:\\%PREFIX%\\node.exe", args: ["C:\\%PREFIX%\\npm-cli.js"] }).file).toBe("C:\\%PREFIX%\\node.exe");
  });
});

describe("verified command execution", () => {
  it("does not accept exit zero with the old version", async () => {
    await expect(verifyCommand({ file: process.execPath, args: ["-e", "console.log('4.14.4')"] }, "9.9.9")).rejects.toThrow(/verification failed/);
  });
  it("accepts newer managed-channel versions but not older ones", async () => {
    const command = { file: process.execPath, args: ["-e", "console.log('10.0.0')"] };
    expect(await verifyCommand(command, "9.9.9", {}, true)).toBe("10.0.0");
    await expect(verifyCommand(command, "11.0.0", {}, true)).rejects.toThrow(/expected at least/);
    expect(compareVersions("9.9.9-rc.2", "9.9.9")).toBeLessThan(0);
  });
  it("bounds stdout and line tails", async () => {
    const lines: string[] = [];
    const output = await runUpdateCommand({ file: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(100000))"] }, { log: (line) => lines.push(line) });
    expect(output.length).toBeLessThanOrEqual(16384);
    expect(lines.every((line) => line.length <= 2048)).toBe(true);
  });
  it("fails an unavailable manager with a useful error", async () => {
    await expect(runUpdateCommand({ file: join(scratch(), "missing"), args: [] })).rejects.toThrow(/could not run/);
  });
  it("never spawns a command after pre-cancellation", async () => {
    const controller = new AbortController(); controller.abort();
    expect(() => runUpdateCommand({ file: "missing", args: [] }, { signal: controller.signal })).toThrow(/cancelled/);
  });
  it("bounds a stalled installer", async () => {
    await expect(runUpdateCommand({ file: process.execPath, args: ["-e", "setTimeout(()=>{},60000)"] }, { timeoutMs: 100 })).rejects.toThrow(/timed out/);
  });
  it.skipIf(process.platform === "win32")("cancels the whole subprocess tree", async () => {
    const root = scratch();
    const stopped = join(root, "stopped");
    const childScript = `process.on('SIGTERM',()=>{require('fs').writeFileSync(${JSON.stringify(stopped)},'stopped');process.exit(0)}); console.log('ready');setInterval(()=>{},1000)`;
    const script = `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'});process.on('SIGTERM',()=>child.once('exit',()=>process.exit(0)))`;
    const controller = new AbortController();
    await expect(runUpdateCommand({ file: process.execPath, args: ["-e", script] }, { signal: controller.signal, log: (line) => { if (line === "ready") controller.abort(); } })).rejects.toThrow(/cancelled/);
    expect(readFileSync(stopped, "utf8")).toBe("stopped");
  });
});

describe("update guards", () => {
  it.each([["freebsd", "x64"], ["linux", "ia32"]] as const)("rejects unsupported target %s/%s", (platform, arch) => {
    expect(() => currentPlatformTarget(platform, arch)).toThrow(/unsupported/);
  });
  it("rejects untrusted version arguments before executing a manager", async () => {
    await expect(performUpdate({ method: method("npm"), version: "latest && touch evil" })).rejects.toThrow(/invalid update version/);
  });
  it("locks the active installation and releases it", () => {
    const active = method("npm", scratch());
    const lock = acquireUpdateLock(active);
    expect(() => acquireUpdateLock(active)).toThrow(/already in progress/);
    lock.release();
    acquireUpdateLock(active).release();
  });
  it("does not release a different update attempt's lock", () => {
    const lock = acquireUpdateLock(method("npm", scratch()));
    const replacement = JSON.stringify({ pid: process.pid, token: "another-attempt" });
    writeFileSync(lock.file, replacement);
    lock.release();
    expect(readFileSync(lock.file, "utf8")).toBe(replacement);
    rmSync(lock.file);
  });
  it("recovers a lock whose owner has exited", () => {
    const active = method("npm", scratch());
    const lock = acquireUpdateLock(active);
    writeFileSync(lock.file, JSON.stringify({ pid: 2147483647 }));
    acquireUpdateLock(active).release();
  });
  it("bounds Windows waiting, verifies replacement, and retains a failed rollback backup", () => {
    const script = windowsUpdateScript(Buffer.from("{}").toString("base64"));
    expect(script).toContain("AddSeconds(120)");
    expect(script).toContain("WaitForExit($limit)");
    expect(script).toContain("$_.Path -eq $task.destination");
    expect(script).not.toContain("IMAGENAME");
    expect(script).toContain("[IO.File]::Replace");
    expect(script).toContain("if ($verified -and $backup)");
    expect(script).toContain("Save-Status 'failed'");
    expect(script).toContain("Get-FileHash");
  });
});
