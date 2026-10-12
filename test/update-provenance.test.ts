import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectInstallMethod, resolveInstallEnv, type DetectEnv } from "../src/commands/update-install.js";
import { readUpdateOrigin, updateOriginEnvironment } from "../src/os/update-origin.js";

const env: DetectEnv = { argv1: "", execPath: "/usr/bin/node", platform: "linux", home: "/home/test" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("update installation provenance", () => {
  it("resolves a PATH symlink into the owning npm package", () => {
    const root = mkdtempSync(join(tmpdir(), "clai-provenance-"));
    roots.push(root);
    const packageRoot = join(root, "lib", "node_modules", "@pentoshi", "clai");
    mkdirSync(join(packageRoot, "bin"), { recursive: true });
    writeFileSync(join(packageRoot, "bin", "clai.mjs"), "");
    const alias = join(root, "clai");
    symlinkSync(join(packageRoot, "bin", "clai.mjs"), alias);
    const method = detectInstallMethod({ ...env, platform: process.platform, execPath: process.execPath, argv1: alias, npmRoot: join(root, "lib", "node_modules") });
    expect(method).toMatchObject({ type: "npm", scope: "global", prefix: realpathSync(root), packageRoot: realpathSync(packageRoot) });
  });

  it("keeps the original Node interpreter when the UI runs under Bun", () => {
    const method = detectInstallMethod({ ...env,
      argv1: "/usr/local/lib/node_modules/@pentoshi/clai/dist/index.js",
      execPath: "/home/test/.bun/bin/bun", runtimePath: "/usr/local/bin/node",
    });
    expect(method).toMatchObject({ type: "npm", runtimePath: "/usr/local/bin/node", prefix: "/usr/local" });
  });

  it("targets a project-local npm installation rather than a global copy", () => {
    const method = detectInstallMethod({ ...env,
      argv1: "/home/test/project/node_modules/@pentoshi/clai/dist/index.js", scope: "local",
    });
    expect(method).toMatchObject({ type: "npm", scope: "local", prefix: "/home/test/project" });
  });

  it("targets pnpm's stable global package instead of an immutable store directory", () => {
    const method = detectInstallMethod({ ...env,
      argv1: "/home/test/.local/share/pnpm/global/5/node_modules/.pnpm/@pentoshi+clai@4.14.4/node_modules/@pentoshi/clai/bin/clai.mjs",
    });
    expect(method).toMatchObject({ type: "pnpm", scope: "global",
      prefix: "/home/test/.local/share/pnpm/global/5",
      packageRoot: "/home/test/.local/share/pnpm/global/5/node_modules/@pentoshi/clai" });
  });

  it("recognizes Yarn Classic's Windows global installation", () => {
    const method = detectInstallMethod({ ...env, platform: "win32", execPath: "C:\\Node\\node.exe",
      argv1: "C:\\Users\\test\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\@pentoshi\\clai\\dist\\index.js",
    });
    expect(method).toMatchObject({ type: "yarn", scope: "global",
      prefix: "C:\\Users\\test\\AppData\\Local\\Yarn\\Data\\global" });
  });

  it("normalizes Windows separators and drive case for the global npm root", () => {
    const method = detectInstallMethod({ ...env, platform: "win32", execPath: "C:\\Node\\node.exe",
      argv1: "C:/Custom/node_modules/@pentoshi/clai/dist/index.js", npmRoot: "c:\\custom\\node_modules",
    });
    expect(method).toMatchObject({ type: "npm", scope: "global", prefix: "C:/Custom" });
  });

  it("recognizes the real Scoop application path, not only its shims", () => {
    const method = detectInstallMethod({ ...env, platform: "win32",
      argv1: "B:\\~BUN\\root\\src\\index.ts",
      execPath: "C:\\Users\\test\\scoop\\apps\\clai\\current\\clai.exe",
      scoopRoot: "C:\\Users\\test\\scoop", scoopShimsDir: "C:\\Users\\test\\scoop\\shims",
    });
    expect(method.type).toBe("scoop");
  });

  it("does not mistake a source directory with a similar prefix for Homebrew ownership", () => {
    expect(detectInstallMethod({ ...env, platform: "darwin", argv1: "/opt/homebrew-other/clai",
      execPath: "/opt/homebrew-other/clai", brewPrefix: "/opt/homebrew" }).type).toBe("binary");
  });

  it("recognizes an arbitrarily renamed native executable with a bundled entry", () => {
    expect(detectInstallMethod({ ...env, argv1: "/$bunfs/root/app", execPath: "/usr/local/bin/custom-assistant" }).type).toBe("binary");
  });

  it.each(["src/index.ts", "dist/index.js", "bin/clai.mjs"])("keeps a genuine checkout entry %s on the source route", (entry) => {
    expect(detectInstallMethod({ ...env, argv1: `/work/clai/${entry}` })).toMatchObject({ type: "dev", packageRoot: "/work/clai" });
  });
});

describe("update origin across runtime handoffs", () => {
  const origin = { argv1: "/usr/local/lib/node_modules/@pentoshi/clai/bin/clai.mjs", execPath: "/usr/local/bin/node" };
  it("preserves the initial launcher through repeated handoffs", () => {
    const result = updateOriginEnvironment({ CLAI_UPDATE_ORIGIN: JSON.stringify(origin), KEEP: "yes" });
    expect(readUpdateOrigin(result)).toEqual(origin);
    expect(result.KEEP).toBe("yes");
  });
  it.each(["bad json", "{}", JSON.stringify({ argv1: "relative", execPath: "/node" }), JSON.stringify({ ...origin, execPath: "/node\nmalicious" }), "x".repeat(8193)])("ignores malformed origin data", (value) => {
    expect(readUpdateOrigin({ CLAI_UPDATE_ORIGIN: value })).toBeUndefined();
  });
  it("accepts Windows absolute paths", () => {
    const value = { argv1: "C:\\npm\\clai.cmd", execPath: "C:\\Node\\node.exe" };
    expect(readUpdateOrigin({ CLAI_UPDATE_ORIGIN: JSON.stringify(value) })).toEqual(value);
  });
});

describe("resolved update environment", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("ignores a launch origin inherited from a different installation", async () => {
    vi.stubEnv("CLAI_UPDATE_ORIGIN", JSON.stringify({
      argv1: "/other/node_modules/@pentoshi/clai/bin/clai.mjs", execPath: "/other/bin/node",
    }));
    const result = await resolveInstallEnv();
    expect(result.argv1).toBe(process.argv[1]);
    expect(result.runtimePath).toBe(process.execPath);
  });
  it("does not ask unrelated package managers where a source checkout is installed", async () => {
    const result = await resolveInstallEnv();
    expect(result.packageRoot).toBe(join(import.meta.dirname, ".."));
    expect(result.brewPrefix).toBeUndefined();
    expect(result.npmRoot).toBeUndefined();
  });
});
