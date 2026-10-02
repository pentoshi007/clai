import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setActiveProjectRoot, clearActiveProjectRoot } from "../../src/agent/project-root.js";
import { createSessionPolicy } from "../../src/agent/session-policy.js";
import { confirmToolExecution, type ConfirmPort } from "../../src/agent/confirm-port.js";
import { authorizeToolExecution } from "../../src/agent/turn/tool-execution/authorization.js";
import { classifyToolCall } from "../../src/safety/classifier.js";
import { filesystemPermission } from "../../src/safety/filesystem-permissions.js";
import { getConfig, updateConfig } from "../../src/store/config.js";
import type { PermissionMode } from "../../src/safety/permission-mode.js";
import type { ToolCall } from "../../src/types.js";

let base: string;
let project: string;
let outside: string;
let previous: PermissionMode | undefined;
const confirm = vi.fn<ConfirmPort["confirmTool"]>();
const port: ConfirmPort = { confirmTool: confirm, confirmPentest: async () => true };

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "clai-permission-modes-"));
  project = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  mkdirSync(join(project, "sub"));
  symlinkSync(outside, join(project, "escape"));
  writeFileSync(join(base, "victim.txt"), "Outside fixture");
  symlinkSync("escape/../victim.txt", join(project, "complex"));
  setActiveProjectRoot(project);
  previous = getConfig().permissions;
  confirm.mockReset().mockResolvedValue(true);
});
afterEach(() => {
  clearActiveProjectRoot();
  updateConfig({ permissions: previous });
  rmSync(base, { recursive: true, force: true });
});

async function authorize(call: ToolCall, mode: PermissionMode, autoConfirm = true) {
  updateConfig({ permissions: mode });
  const decision = classifyToolCall(call);
  return authorizeToolExecution({ call, toolEventId: "test", parentSignal: new AbortController().signal, level: decision.level, reason: decision.reason }, {
    autoConfirm, session: createSessionPolicy(), confirmPort: port,
    acquirePrompt: async () => () => {}, writeToolBlocked: () => {}, emitToolResult: () => {},
  });
}

const shell = (command: string, cwd: string): ToolCall => ({ name: "shell.exec", args: { command, cwd } });

describe("filesystem permission modes at the authorization boundary", () => {
  it.each(["fs.write", "fs.edit", "fs.append", "fs.replaceLines"])("default allows %s inside the active folder", async (name) => {
    expect((await authorize({ name, args: { path: "new/nested.txt" } }, "default", false)).kind).toBe("proceed");
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["default", "allow-all", "full-access"] as const)("%s applies direct delete scope", async (mode) => {
    await authorize({ name: "fs.delete", args: { path: "local.txt" } }, mode);
    expect(confirm).toHaveBeenCalledTimes(mode === "default" ? 1 : 0);
    confirm.mockClear();
    await authorize({ name: "fs.delete", args: { path: join(outside, "file.txt") } }, mode);
    expect(confirm).toHaveBeenCalledTimes(mode === "full-access" ? 0 : 1);
  });

  it.each(["default", "allow-all", "full-access"] as const)("%s applies outside write scope", async (mode) => {
    await authorize({ name: "fs.writeMany", args: { files: [{ path: "local.txt" }, { path: join(outside, "other.txt") }] } }, mode);
    expect(confirm).toHaveBeenCalledTimes(mode === "default" ? 1 : 0);
  });

  it.each([
    "rm local.txt", "rm -rf sub", "/bin/rm -- 'space name.txt'", "printf data | rm local.txt",
    "command rm local.txt", "env FOO=bar rm local.txt", "sudo rm local.txt", "bash -c 'rm local.txt'",
    "rm local.txt && rm sub/other.txt", "cd sub && rm local.txt", "r\\m local.txt", "rm 'literal*name.txt'", "rm '>'",
    "rm sub/../local.txt", "rm '~/literal.txt'",
  ])("auto-allow permits proven local deletion: %s", async (command) => {
    expect((await authorize(shell(command, project), "allow-all")).kind).toBe("proceed");
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    "rm ../outside/file.txt", "printf data | rm ../outside/file.txt", "rm local.txt; rm ../outside/file.txt",
    "rm escape/../victim.txt", "cd escape && rm ../victim.txt", "rm ~anotheruser/victim.txt",
    "env --chdir=../outside rm file.txt", "env -C../outside rm file.txt", "sudo -D../outside rm file.txt",
    "CDPATH=../outside cd sub && rm file.txt",
    "command rm ../outside/file.txt", "env rm ../outside/file.txt", "bash -c 'rm ../outside/file.txt'",
    "printf '%s' ../outside/file.txt | xargs rm", "find ../outside -type f -delete", "rm escape/file.txt",
    "rm \"$TARGET\"", "rm $(cat targets)", "cd ../outside && rm file.txt", "env -C ../outside rm file.txt",
    "printf 'rm ../outside/file.txt' | sh", "for f in ../outside/*; do rm \"$f\"; done",
    "if true; then rm ../outside/file.txt; fi", "busybox rm ../outside/file.txt", "env --chdir ../outside rm file.txt",
    "python -c \"import os; os.system('rm ../outside/file.txt')\"", "eval 'rm ../outside/file.txt'",
    "rm -$FLAGS local.txt", "rmdir -p sub", "$COMMAND ../outside/file.txt", "echo $(rm ../outside/file.txt)",
    "cd sub; rm ../outside/file.txt", "cd sub && echo done; rm ../outside/file.txt",
    "> /dev/null cd ../outside && rm file.txt", "cd sub # comment\nrm ../outside/file.txt",
  ])("auto-allow cannot bypass outside/uncertain deletion: %s", async (command) => {
    await authorize(shell(command, project), "allow-all");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("an explicit outside cwd is not the active folder", async () => {
    await authorize(shell("rm file.txt", outside), "allow-all");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("uses the physical cwd when an explicit cwd traverses a symlink", async () => {
    await authorize(shell("rm victim.txt", `${project}/escape/..`), "allow-all");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each(["rm local.txt", "printf data | rm local.txt", "bash -c 'rm local.txt'"])("default always prompts for deletion: %s", async (command) => {
    await authorize(shell(command, project), "default");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each(["mkdir new", "touch new.txt", "printf hello > new.txt", "cp source.txt destination.txt", "tee new.txt"])("default allows local filesystem mutation: %s", async (command) => {
    await authorize(shell(command, project), "default", false);
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(["cp --target-directory=../outside source.txt", "install -d ../outside/new sub/new", "echo data > ../outside/new.txt", "touch ../outside/new.txt", "touch escape/../victim.txt"])("default prompts for outside shell writes: %s", async (command) => {
    await authorize(shell(command, project), "default");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each(["fs.write", "fs.delete"])("%s resolves traversal inside a symlink's target physically", async (name) => {
    await authorize({ name, args: { path: "complex" } }, name === "fs.write" ? "default" : "allow-all");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("outside deletes cannot use per-tool allow lists or --yes to bypass the scope", async () => {
    updateConfig({ permissions: "allow-all" });
    const session = createSessionPolicy();
    session.allow.add("shell.exec");
    await confirmToolExecution(shell("rm file.txt", outside), true, session, port);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("a declined outside deletion prevents execution", async () => {
    confirm.mockResolvedValue(false);
    const outcome = await authorize(shell("rm file.txt", outside), "allow-all");
    expect(outcome.kind).toBe("stop");
    if (outcome.kind === "stop") expect(outcome.result.result.output).toBe("Cancelled.");
  });

  it("full-access skips filesystem prompts, including ambiguous shell targets", async () => {
    await authorize(shell("rm \"$TARGET\"; rm ../outside/file.txt", project), "full-access");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("retains hard blocks independently of full-access", async () => {
    expect((await authorize(shell("rm -rf /", project), "full-access")).kind).toBe("stop");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("a temporary sibling is outside even though the project itself is in tmp", () => {
    expect(filesystemPermission({ name: "fs.delete", args: { path: join(outside, "file") } }, "allow-all")).toBe("confirm");
  });
});
