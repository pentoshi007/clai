import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { zipFixture } from "./helpers/zip-fixture.js";

const fixture = zipFixture([{ name: "rtk.exe", body: "verified release fixture" }]);

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "win32" });
const state = vi.hoisted(() => ({ code: 2316632107, dir: "", afterVersion: "0.23.0", badProbe: false }));
const old = { state: "ready" as const, path: "C:\\Microsoft\\WinGet\\Links\\rtk.exe", version: "0.23.0" };

vi.mock("../src/os/command.js", async (original) => ({
  ...await original<typeof import("../src/os/command.js")>(),
  findExecutable: vi.fn(async (name: string) => name === "winget" ? "winget.exe" : undefined),
  augmentedPathEnv: () => "",
}));
vi.mock("../src/tools/rtk/binary.js", async (original) => ({
  ...await original<typeof import("../src/tools/rtk/binary.js")>(),
  detectRtk: vi.fn(async () => state.badProbe ? { state: "missing" } : { ...old, version: state.afterVersion }),
  inspectRtkPath: vi.fn(async (path: string) => ({ state: "ready", path, version: "0.24.0" })),
  probeRtkPath: vi.fn(async (path: string) => ({ state: "ready", path, version: "0.24.0" })),
  forgetRtk: vi.fn(),
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
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { stderr: new EventEmitter(), stdout: new EventEmitter(), pid: 4242, kill: () => true });
    queueMicrotask(() => child.emit("close", state.code, null));
    return child;
  }),
}));

let root = "";
beforeEach(async () => {
  root ||= await mkdtemp(join(tmpdir(), "rtk-windows-regression-"));
  state.dir = join(root, "bin");
  state.afterVersion = "0.23.0";
  state.badProbe = false;
  const { detectRtk } = await import("../src/tools/rtk/binary.js");
  vi.mocked(detectRtk).mockReset().mockImplementation(async () => state.badProbe ? { state: "missing" } : { ...old, version: state.afterVersion });
  vi.mocked(detectRtk).mockResolvedValueOnce(old);
});
afterAll(async () => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  await rm(root, { recursive: true, force: true });
});

describe("Windows verified release fallback", () => {
  it.each([2316632107, 2316632107 | 0, 0])("falls back without Rust when winget returns %s and leaves the old version", async (code) => {
    state.code = code;
    const { runRtkMaintenance } = await import("../src/tools/rtk/install.js");
    const result = await runRtkMaintenance("update");
    expect(result).toMatchObject({ ok: true, action: "update", installer: "GitHub releases", previousVersion: "0.23.0", status: { version: "0.24.0", path: join(state.dir, "rtk.exe") } });
  });

  it("continues after winget reports success but its executable cannot be probed", async () => {
    state.code = 0;
    state.badProbe = true;
    const { runRtkMaintenance } = await import("../src/tools/rtk/install.js");
    expect(await runRtkMaintenance("update")).toMatchObject({ ok: true, installer: "GitHub releases" });
  });
});
