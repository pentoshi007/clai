import { afterEach, describe, expect, it, vi } from "vitest";
import { isNodeExecutable, nodeTarget, reaEnvironment, resolveReaNode, runReaNode, supportsReaNode } from "../../src/rea/node.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("REA runtime selection", () => {
  it.each(["22.19.0", "v22.22.2", "24.15.0", "v24.22.0", "26.0.0", "27.1.0"])("supports compatible Node %s", (version) => {
    expect(supportsReaNode(version)).toBe(true);
  });
  it.each(["18.20.0", "20.19.0", "22.18.0", "24.10.0", "25.0.0", "1.3.5", "node 24.1", "24.15.0-rc.1"])("rejects unsupported runtime %s", (version) => {
    expect(supportsReaNode(version)).toBe(false);
  });
  it.each([
    ["22.23.3", false], ["22.23.4", true], ["24.19.0", false], ["24.22.0", false], ["24.22.1", true],
    ["26.12.0", false], ["26.12.1", true],
  ])("checks Node %s against REA's published patch-level requirement", (version, compatible) => {
    expect(supportsReaNode(version, "^22.23.4 || ^24.22.1 || >=26.12.1")).toBe(compatible);
  });
  it("looks for a private build when the configured Node cannot run the release", async () => {
    vi.stubEnv("CLAI_REA_NODE", process.execPath);
    const fetch = vi.fn(async () => new Response("[]"));
    vi.stubGlobal("fetch", fetch);
    await expect(resolveReaNode("unused", { nodeRange: ">=999.0.0" })).rejects.toThrow(/No official .*Node\.js >=999\.0\.0/);
    expect(fetch).toHaveBeenCalledOnce();
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
    expect(() => nodeTarget("linux", "riscv64")).toThrow(/compatible Node\.js with npm.*CLAI_REA_NODE/);
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

  it("reports the subprocess error instead of the command and its arguments", async () => {
    const script = "console.error('npm error code EBADENGINE'); process.exitCode = 1;";
    await expect(runReaNode(process.execPath, ["-e", script])).rejects.toHaveProperty("message", "npm error code EBADENGINE");
  });
});
