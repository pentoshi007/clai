import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterAll, describe, expect, it, vi } from "vitest";

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "win32" });

const winget = vi.hoisted(() => ({ exitCode: 0x8a15002b as number | null }));
const rtkPath = "C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links\\rtk.exe";

vi.mock("../src/os/command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/os/command.js")>()),
  findExecutable: vi.fn(async (name: string) => (name === "winget" ? "C:\\winget.exe" : undefined)),
  augmentedPathEnv: (): string => "",
}));

vi.mock("../src/tools/rtk/binary.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/rtk/binary.js")>()),
  detectRtk: vi.fn(),
  probeRtkPath: vi.fn(),
  forgetRtk: vi.fn(),
}));

vi.mock("../src/tools/rtk/release.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/rtk/release.js")>()),
  resolveLatestTag: vi.fn(async () => "v0.24.0"),
  currentTarget: vi.fn(() => undefined),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(() => {
    const child = new EventEmitter() as unknown as ChildProcess & {
      stderr: EventEmitter;
      stdout: EventEmitter;
      pid: number;
      kill: () => void;
    };
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    child.pid = 4242;
    child.kill = () => undefined;
    queueMicrotask(() => child.emit("close", winget.exitCode, null));
    return child;
  }),
}));

afterAll(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

const ready = (version: string) => ({ state: "ready" as const, path: rtkPath, version });

describe("winget exit classification", () => {
  it("treats no-applicable-update and already-installed codes as nothing to do", async () => {
    const { classifyWingetExit } = await import("../src/tools/rtk/install.js");
    expect(classifyWingetExit(2316632107)).toEqual({ ok: false, noOp: "no applicable update found" });
    expect(classifyWingetExit(2316632107 | 0)).toEqual({ ok: false, noOp: "no applicable update found" });
    expect(classifyWingetExit(0x8a15004f)).toEqual({
      ok: false,
      noOp: "the available version is not newer than the installed one",
    });
    expect(classifyWingetExit(0x8a150061)).toEqual({ ok: false, noOp: "rtk-ai.rtk is already installed" });
  });

  it("explains actionable winget failures instead of a bare exit code", async () => {
    const { classifyWingetExit } = await import("../src/tools/rtk/install.js");
    const admin = classifyWingetExit(0x8a150019);
    expect(admin && "reason" in admin ? admin.reason : "").toContain("administrator rights");
    expect(admin && "reason" in admin ? admin.reason : "").toContain("2316632089");
    expect(classifyWingetExit(5)).toBeUndefined();
    expect(classifyWingetExit(undefined)).toBeUndefined();
  });
});

describe("Windows rtk maintenance with winget", () => {
  const stubs = async (): Promise<{ install: typeof import("../src/tools/rtk/install.js"); binary: typeof import("../src/tools/rtk/binary.js") }> => {
    const binary = await import("../src/tools/rtk/binary.js");
    vi.mocked(binary.forgetRtk).mockImplementation(() => undefined);
    vi.mocked(binary.probeRtkPath).mockResolvedValue(ready("0.24.0"));
    return { install: await import("../src/tools/rtk/install.js"), binary };
  };

  it("reports rtk as already the latest instead of failing on winget's no-applicable-update code", async () => {
    const { install, binary } = await stubs();
    vi.mocked(binary.detectRtk).mockResolvedValue(ready("0.24.0"));
    winget.exitCode = 2316632107;
    const result = await install.runRtkMaintenance("update");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.installer).toBeUndefined();
      expect(result.status.version).toBe("0.24.0");
    }
  });

  it("keeps a real failure actionable when winget cannot deliver the newer release", async () => {
    const { install, binary } = await stubs();
    vi.mocked(binary.detectRtk).mockResolvedValue(ready("0.23.0"));
    winget.exitCode = 2316632107;
    const result = await install.runRtkMaintenance("update");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("no applicable update found");
      expect(result.reason).toContain("latest published is 0.24.0");
      expect(result.reason).toContain("cargo is not installed");
      expect(result.reason).not.toContain("2316632107");
    }
  });

  it("accepts winget's already-installed code during install", async () => {
    const { install, binary } = await stubs();
    vi.mocked(binary.detectRtk).mockResolvedValueOnce({ state: "missing" }).mockResolvedValue(ready("0.24.0"));
    winget.exitCode = 0x8a150061;
    const result = await install.runRtkMaintenance("install");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.installer).toBe("winget");
  });
});
