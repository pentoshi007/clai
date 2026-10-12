import { describe, expect, it } from "vitest";
import { detectInstallMethod, type DetectEnv } from "../src/commands/update-install.js";

const base: DetectEnv = {
  argv1: "/opt/homebrew/bin/clai",
  execPath: "/opt/homebrew/bin/clai",
  platform: "darwin",
  home: "/Users/test",
};

describe("active installation update routing", () => {
  it.each([
    { platform: "darwin" as const, execPath: "/Users/test/.local/bin/clai" },
    { platform: "linux" as const, execPath: "/home/test/.local/bin/clai" },
    { platform: "win32" as const, execPath: "C:\\Users\\test\\clai\\clai.exe" },
  ])("recognizes bundled source paths as a compiled binary on $platform", (input) => {
    const method = detectInstallMethod({ ...base, ...input, argv1: "/$bunfs/root/src/index.ts" });
    expect(method.type).toBe("binary");
  });

  it("routes a compiled Homebrew binary through Homebrew despite its bundled entry", () => {
    const method = detectInstallMethod({
      ...base,
      argv1: "/$bunfs/root/src/index.ts",
      execPath: "/opt/homebrew/opt/clai/bin/clai",
      brewPrefix: "/opt/homebrew/opt/clai",
    });
    expect(method.type).toBe("brew");
  });

  it("recognizes the npm entry after Node-to-Bun re-execution", () => {
    const method = detectInstallMethod({
      ...base,
      argv1: "/opt/homebrew/lib/node_modules/@pentoshi/clai/dist/index.js",
      execPath: "/Users/test/.bun/bin/bun",
      npmRoot: "/opt/homebrew/lib/node_modules",
    });
    expect(method.type).toBe("npm");
  });

  it("recognizes the Bun package entry before the source suffix", () => {
    const method = detectInstallMethod({
      ...base,
      argv1: "/Users/test/.bun/install/global/node_modules/@pentoshi/clai/dist/index.js",
      execPath: "/Users/test/.bun/bin/bun",
      bunRoot: "/Users/test/.bun/install/global/node_modules",
    });
    expect(method.type).toBe("bun");
  });

  it("does not update an unrelated installed Homebrew copy instead of the active binary", () => {
    const method = detectInstallMethod({
      ...base,
      argv1: "/Users/test/.local/bin/clai",
      execPath: "/Users/test/.local/bin/clai",
      brewPrefix: "/opt/homebrew/opt/clai",
    });
    expect(method.type).toBe("binary");
  });

  it("does not update an unrelated Homebrew copy instead of the active npm installation", () => {
    const method = detectInstallMethod({
      ...base,
      argv1: "/opt/homebrew/lib/node_modules/@pentoshi/clai/bin/clai.mjs",
      execPath: "/opt/homebrew/bin/node",
      npmRoot: "/opt/homebrew/lib/node_modules",
      brewPrefix: "/opt/homebrew/opt/clai",
    });
    expect(method.type).toBe("npm");
  });

  it("supports Homebrew on Linux", () => {
    const method = detectInstallMethod({
      ...base,
      platform: "linux",
      argv1: "/home/linuxbrew/.linuxbrew/opt/clai/bin/clai",
      execPath: "/home/linuxbrew/.linuxbrew/opt/clai/bin/clai",
      brewPrefix: "/home/linuxbrew/.linuxbrew/opt/clai",
    });
    expect(method.type).toBe("brew");
  });

  it("does not infer a clai package merely from any node_modules path", () => {
    const method = detectInstallMethod({
      ...base,
      argv1: "/work/node_modules/something-else/bin/cli.js",
      execPath: "/usr/bin/node",
    });
    expect(method.type).toBe("unknown");
  });
});
