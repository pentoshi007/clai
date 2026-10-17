import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { zipFixture } from "./helpers/zip-fixture.js";

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "win32" });
const state = vi.hoisted(() => ({ dir: "", badBinary: false, replacementDenied: false, commitDenied: false }));
const fixture = zipFixture([{ name: "rtk.exe", body: "new executable" }]);

vi.mock("../src/os/command.js", async (original) => ({
  ...await original<typeof import("../src/os/command.js")>(),
  findExecutable: vi.fn(async () => undefined), augmentedPathEnv: () => "",
}));
vi.mock("../src/tools/rtk/binary.js", async (original) => ({
  ...await original<typeof import("../src/tools/rtk/binary.js")>(),
  detectRtk: vi.fn(), forgetRtk: vi.fn(),
  inspectRtkPath: vi.fn(async (path: string) => state.badBinary
    ? { state: "incompatible", path }
    : { state: "ready", path, version: "0.24.0" }),
  probeRtkPath: vi.fn(async (path: string) => ({ state: "ready", path, version: "0.24.0" })),
}));
vi.mock("../src/tools/rtk/release.js", async (original) => ({
  ...await original<typeof import("../src/tools/rtk/release.js")>(),
  resolveLatestTag: vi.fn(async () => "v0.24.0"),
  releaseForTag: vi.fn(async () => ({ tag: "v0.24.0", version: "0.24.0", checksums: new Map([["rtk-x86_64-pc-windows-msvc.zip", createHash("sha256").update(fixture).digest("hex")]]) })),
  currentTarget: () => ({ os: "windows", machine: "x86_64", asset: "rtk-x86_64-pc-windows-msvc.zip" }),
  installDir: () => state.dir,
}));
vi.mock("../src/tools/rtk/download.js", () => ({
  downloadToFile: vi.fn(async (_url: string, file: string) => writeFile(file, fixture)),
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: vi.fn(async (from: string, to: string) => {
    if (to === join(state.dir, "rtk.exe") && from.endsWith(".tmp")) {
      const destinationExists = await fs.stat(to).then(() => true, () => false);
      if (state.commitDenied || state.replacementDenied && destinationExists) {
        throw Object.assign(new Error("binary is in use"), { code: "EPERM" });
      }
    }
    await fs.rename(from, to);
  }) };
});
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(() => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(), stderr: new EventEmitter(), stdout: new EventEmitter() });
    queueMicrotask(() => child.emit("error", Object.assign(new Error("shell is not installed"), { code: "ENOENT" })));
    return child;
  }),
}));

let root = "";
beforeEach(async () => {
  root ||= await mkdtemp(join(tmpdir(), "rtk portable "));
  state.dir = await mkdtemp(join(root, "bin "));
  state.badBinary = false;
  state.replacementDenied = false;
  state.commitDenied = false;
  const { detectRtk } = await import("../src/tools/rtk/binary.js");
  vi.mocked(detectRtk).mockReset().mockResolvedValue({ state: "missing" });
  const { spawn } = await import("node:child_process");
  vi.mocked(spawn).mockClear();
});
afterAll(async () => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  await rm(root, { recursive: true, force: true });
});

async function maintain(action: "install" | "update") {
  return (await import("../src/tools/rtk/install.js")).runRtkMaintenance(action);
}

describe("Windows portable RTK maintenance", () => {
  it("installs without winget, Scoop, Cargo, PowerShell, tar, or an existing PATH entry", async () => {
    const result = await maintain("install");
    expect(result).toMatchObject({ ok: true, installer: "GitHub releases", status: { path: join(state.dir, "rtk.exe") } });
    expect(await readFile(join(state.dir, "rtk.exe"), "utf8")).toBe("new executable");
    expect((await import("node:child_process")).spawn).not.toHaveBeenCalled();
  });

  it.each(["C:\\manual tools\\rtk.exe", join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".cargo", "bin", "rtk.exe")])("updates a manually placed binary without its original package manager: %s", async (path) => {
    const { detectRtk } = await import("../src/tools/rtk/binary.js");
    vi.mocked(detectRtk).mockResolvedValue({ state: "ready", path, version: "0.23.0" });
    expect(await maintain("update")).toMatchObject({ ok: true, installer: "GitHub releases", previousVersion: "0.23.0", status: { version: "0.24.0" } });
  });

  it("checks the staged executable before replacing a working installation", async () => {
    const dest = join(state.dir, "rtk.exe");
    await writeFile(dest, "previous executable");
    state.badBinary = true;
    const result = await maintain("install");
    expect(result.ok).toBe(false);
    expect(await readFile(dest, "utf8")).toBe("previous executable");
    if (!result.ok) expect(result.reason).toContain("downloaded rtk binary");
  });

  it("moves the previous executable aside when Windows denies overwriting it", async () => {
    await writeFile(join(state.dir, "rtk.exe"), "previous executable");
    state.replacementDenied = true;
    expect(await maintain("install")).toMatchObject({ ok: true });
    expect(await readFile(join(state.dir, "rtk.exe"), "utf8")).toBe("new executable");
    expect(await readdir(state.dir)).toEqual(["rtk.exe"]);
  });

  it("restores the previous executable if committing the new binary also fails", async () => {
    await writeFile(join(state.dir, "rtk.exe"), "previous executable");
    state.replacementDenied = true;
    state.commitDenied = true;
    expect((await maintain("install")).ok).toBe(false);
    expect(await readFile(join(state.dir, "rtk.exe"), "utf8")).toBe("previous executable");
    expect(await readdir(state.dir)).toEqual(["rtk.exe"]);
  });
});
