import { describe, expect, it } from "vitest";
import {
  currentPlatformTarget,
  detectInstallMethod,
  type DetectEnv,
} from "../src/commands/update-install.js";

function env(overrides: Partial<DetectEnv>): DetectEnv {
  return {
    argv1: "/usr/local/bin/clai",
    execPath: "/usr/local/bin/clai",
    platform: "darwin",
    home: "/Users/test",
    ...overrides,
  };
}

describe("currentPlatformTarget", () => {
  it("maps darwin arm64", () => {
    const t = currentPlatformTarget("darwin", "arm64");
    expect(t.platform).toBe("darwin");
    expect(t.arch).toBe("arm64");
    expect(t.asset).toBe("clai-bun-darwin-arm64");
    expect(t.file).toBe("clai-bun-darwin-arm64");
  });

  it("maps darwin x64", () => {
    const t = currentPlatformTarget("darwin", "x64");
    expect(t.file).toBe("clai-bun-darwin-x64");
  });

  it("maps linux arch variants to x64/arm64", () => {
    expect(currentPlatformTarget("linux", "x64").file).toBe("clai-bun-linux-x64");
    expect(currentPlatformTarget("linux", "arm64").file).toBe("clai-bun-linux-arm64");
  });

  it("appends .exe for windows", () => {
    const t = currentPlatformTarget("win32", "x64");
    expect(t.platform).toBe("windows");
    expect(t.file).toBe("clai-bun-windows-x64.exe");
  });
});

describe("detectInstallMethod", () => {
  it("detects a source checkout", () => {
    const m = detectInstallMethod(
      env({ argv1: "/repo/clai/src/index.ts", execPath: "/usr/local/bin/node" }),
    );
    expect(m.type).toBe("dev");
  });

  it("detects npm global install", () => {
    const m = detectInstallMethod(
      env({
        argv1: "/usr/local/lib/node_modules/@pentoshi/clai/bin/clai.mjs",
        execPath: "/usr/local/bin/node",
        npmRoot: "/usr/local/lib/node_modules",
      }),
    );
    expect(m.type).toBe("npm");
  });

  it("detects bun global install", () => {
    const m = detectInstallMethod(
      env({
        argv1: "/Users/test/.bun/install/global/node_modules/@pentoshi/clai/bin/clai.mjs",
        execPath: "/usr/local/bin/node",
        bunRoot: "/Users/test/.bun/install/global/node_modules",
      }),
    );
    expect(m.type).toBe("bun");
  });

  it("detects homebrew on macOS", () => {
    const m = detectInstallMethod(
      env({
        argv1: "/opt/homebrew/bin/clai",
        execPath: "/opt/homebrew/bin/clai",
        brewPrefix: "/opt/homebrew",
      }),
    );
    expect(m.type).toBe("brew");
  });

  it("does not treat brew prefix as binary when absent", () => {
    const m = detectInstallMethod(env({ argv1: "/usr/local/bin/clai" }));
    expect(m.type).toBe("binary");
  });

  it("detects scoop on windows", () => {
    const m = detectInstallMethod(
      env({
        platform: "win32",
        argv1: "C:\\Users\\test\\scoop\\shims\\clai.exe",
        execPath: "C:\\Users\\test\\scoop\\shims\\clai.exe",
        scoopShimsDir: "C:\\Users\\test\\scoop\\shims",
      }),
    );
    expect(m.type).toBe("scoop");
  });

  it("detects a standalone compiled binary", () => {
    const m = detectInstallMethod(
      env({ argv1: "/usr/local/bin/clai", execPath: "/usr/local/bin/clai" }),
    );
    expect(m.type).toBe("binary");
  });

  it("detects a windows standalone binary", () => {
    const m = detectInstallMethod(
      env({
        platform: "win32",
        argv1: "C:\\tools\\clai.exe",
        execPath: "C:\\tools\\clai.exe",
      }),
    );
    expect(m.type).toBe("binary");
  });

  it("returns unknown for unrecognized executables", () => {
    const m = detectInstallMethod(
      env({ argv1: "/usr/bin/something-else", execPath: "/usr/bin/something-else" }),
    );
    expect(m.type).toBe("unknown");
  });
});