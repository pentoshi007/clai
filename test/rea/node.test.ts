import { afterEach, describe, expect, it, vi } from "vitest";
import { isNodeExecutable, nodeTarget, reaEnvironment, supportsReaNode } from "../../src/rea/node.js";

afterEach(() => vi.unstubAllEnvs());

describe("REA runtime selection", () => {
  it.each(["22.19.0", "v22.22.2", "24.15.0", "v24.22.0", "26.0.0", "27.1.0"])("supports compatible Node %s", (version) => {
    expect(supportsReaNode(version)).toBe(true);
  });
  it.each(["18.20.0", "20.19.0", "22.18.0", "24.10.0", "25.0.0", "1.3.5", "node 24.1", "24.15.0-rc.1"])("rejects unsupported runtime %s", (version) => {
    expect(supportsReaNode(version)).toBe(false);
  });
  it.each([
    ["darwin", "arm64", "darwin-arm64"], ["darwin", "x64", "darwin-x64"],
    ["linux", "arm64", "linux-arm64"], ["linux", "x64", "linux-x64"],
    ["win32", "arm64", "win-arm64"], ["win32", "x64", "win-x64"],
  ] as const)("selects the official %s/%s runtime", (platform, arch, target) => {
    expect(nodeTarget(platform, arch)).toBe(target);
  });
  it("handles musl separately and explains unsupported architectures", () => {
    expect(nodeTarget("linux", "x64", true)).toBe("linux-x64-musl");
    expect(() => nodeTarget("linux", "riscv64")).toThrow(/supported portable/);
    expect(() => nodeTarget("freebsd", "x64")).toThrow(/supported portable/);
  });
  it("tells users how to supply their own Node when no portable runtime fits the host", () => {
    expect(() => nodeTarget("linux", "riscv64")).toThrow(/CLAI_REA_NODE/);
    expect(() => nodeTarget("freebsd", "x64")).toThrow(/Node\.js 22\.19\+, 24\.15\+ or 26\+/);
  });
  it.each(["/usr/local/bin/node", "C:\\Program Files\\nodejs\\node.exe", "/opt/NODE.EXE"])("probes %s as a Node executable", (path) => {
    expect(isNodeExecutable(path)).toBe(true);
  });
  it.each(["/usr/local/bin/clai", "/Users/me/.bun/bin/bun", "C:\\clai\\clai.exe", "/usr/bin/nodemon", "/usr/bin/node24"])("never executes %s while looking for Node", (path) => {
    expect(isNodeExecutable(path)).toBe(false);
  });
  it("uses the selected runtime in child processes and excludes hostile npm configuration", () => {
    vi.stubEnv("npm_config_registry", "https://untrusted.test");
    vi.stubEnv("NODE_OPTIONS", "--require=untrusted");
    vi.stubEnv("NODE_PATH", "/untrusted");
    const env = reaEnvironment(process.execPath);
    expect(env.npm_config_registry).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.NODE_PATH).toBeUndefined();
    expect(Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1]).toContain(process.execPath.replace(/[\\/][^\\/]+$/, ""));
  });
});
