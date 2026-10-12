import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installViaPackageManager } from "../src/commands/update/package-managers.js";
import type { PerformUpdateOptions } from "../src/commands/update-install.js";
import { writableDirectory } from "../src/commands/update/native.js";
import { runUpdateCommand } from "../src/commands/update/process.js";
import { obtainSudoPassword } from "../src/tools/sudo-session.js";

vi.mock("../src/commands/update/native.js", () => ({ writableDirectory: vi.fn() }));
vi.mock("../src/commands/update/process.js", async (original) => ({ ...await original<typeof import("../src/commands/update/process.js")>(), runUpdateCommand: vi.fn() }));
vi.mock("../src/tools/sudo-session.js", async (original) => ({ ...await original<typeof import("../src/tools/sudo-session.js")>(), obtainSudoPassword: vi.fn() }));
let root: string;
let options: PerformUpdateOptions;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "clai-manager-safety-"));
  options = { version: "9.9.9", method: { type: "npm", detail: "fixture", prefix: root, packageRoot: join(root, "lib", "node_modules", "@pentoshi", "clai"), runtimePath: process.execPath, scope: "global", managerPath: process.execPath } };
  vi.mocked(writableDirectory).mockReturnValue(false);
  vi.mocked(runUpdateCommand).mockResolvedValue("9.9.9");
});
afterEach(() => { vi.resetAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("protected package-manager updates", () => {
  it("uses secret stdin, an absolute manager and the active prefix, then verifies as the user", async () => {
    vi.mocked(obtainSudoPassword).mockResolvedValue({ status: "granted", password: "fixture-password", fromCache: false });
    const result = await installViaPackageManager({ ...options, requestSecret: async () => "fixture-password" });
    expect(result).toMatchObject({ outcome: "applied", installedVersion: "9.9.9" });
    const [command, run] = vi.mocked(runUpdateCommand).mock.calls[0]!;
    expect(command.file).toBe("sudo");
    expect(command.args.slice(0, 5)).toEqual(["-S", "-p", "", "--", "env"]);
    expect(command.args).toContain(process.execPath);
    expect(command.args).toContain(root);
    expect(command.args.join(" ")).not.toContain("fixture-password");
    expect(run?.input).toBe("fixture-password\n");
    expect(vi.mocked(runUpdateCommand).mock.calls[1]?.[0].file).toBe(process.execPath);
  });
  it.each(["cancelled", "failed"] as const)("never runs a manager after authentication is %s", async (status) => {
    vi.mocked(obtainSudoPassword).mockResolvedValue({ status });
    await expect(installViaPackageManager({ ...options, requestSecret: async () => undefined })).rejects.toThrow(status === "cancelled" ? /cancelled/ : /authentication failed/);
    expect(runUpdateCommand).not.toHaveBeenCalled();
  });
  it("uses noninteractive sudo and actionable guidance without a secret requester", async () => {
    vi.mocked(runUpdateCommand).mockRejectedValue(new Error("sudo requires a password"));
    await expect(installViaPackageManager(options)).rejects.toThrow(/protected npm installation.*administrator prompt/);
    expect(vi.mocked(runUpdateCommand).mock.calls[0]?.[0].args[0]).toBe("-n");
    expect(obtainSudoPassword).not.toHaveBeenCalled();
  });
  it("does not elevate local installs even when the directory is protected", async () => {
    await installViaPackageManager({ ...options, method: { ...options.method, scope: "local" } });
    expect(vi.mocked(runUpdateCommand).mock.calls[0]?.[0].file).toBe(process.execPath);
    expect(obtainSudoPassword).not.toHaveBeenCalled();
  });
});
