import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineRoots, readEngineSettings } from "../../src/rea/engines.js";
import {
  buildGhidraDecompiler, buildToolsHelp, bundlesDecompiler, compareVersions, decompilerBuildTarget, decompilerDirectory,
  ghidraHostProblem, inspectGhidraDirectory, installGhidra, selectGhidraRelease, supportedGhidraVersion, type EngineHost, type GhidraRelease,
} from "../../src/rea/ghidra.js";
import { zipArchive, type ArchiveEntry } from "../helpers/zip-archive.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clai-ghidra-"));
  directories.push(path);
  return path;
}

const LINUX: EngineHost = { platform: "linux", arch: "x64" };
const MAC: EngineHost = { platform: "darwin", arch: "arm64" };
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const asset = (version: string, overrides: Record<string, unknown> = {}) => ({
  name: `ghidra_${version}_PUBLIC_20260921.zip`, size: 569_649_598, state: "uploaded", digest: `sha256:${"a".repeat(64)}`, ...overrides,
});
const release = (version: string, overrides: Record<string, unknown> = {}, assets: unknown[] = [asset(version)]) => ({
  tag_name: `Ghidra_${version}_build`, draft: false, prerelease: false, assets, ...overrides,
});

describe("Ghidra release selection", () => {
  it("chooses the newest 12.1.x release and builds the download address itself", () => {
    const chosen = selectGhidraRelease([release("12.1.2"), release("12.1.4"), release("12.1"), release("12.0.4"), release("13.0")]);
    expect(chosen).toMatchObject({
      version: "12.1.4", tag: "Ghidra_12.1.4_build", name: "ghidra_12.1.4_PUBLIC_20260921.zip", bytes: 569_649_598, sha256: "a".repeat(64),
      url: "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_12.1.4_build/ghidra_12.1.4_PUBLIC_20260921.zip",
    });
    expect(selectGhidraRelease([release("12.1"), release("12.1.10"), release("12.1.9")]).version).toBe("12.1.10");
  });

  it("skips drafts, prereleases, other series, odd archives and anything without a usable checksum", () => {
    const usable = release("12.1.2");
    const candidates = [
      release("12.1.9", { draft: true }), release("12.1.8", { prerelease: true }), release("12.2.1"), release("11.4.3"),
      release("12.1.7", {}, [asset("12.1.7", { digest: null })]),
      release("12.1.6", {}, [asset("12.1.6", { digest: "sha1:abc" })]),
      release("12.1.6", {}, [asset("12.1.6", { size: 1_000 })]),
      release("12.1.6", {}, [asset("12.1.6", { size: 9_999_999_999 })]),
      release("12.1.6", {}, [asset("12.1.6", { name: "ghidra_12.1.6_PUBLIC_20260921.zip.sig" })]),
      release("12.1.6", {}, [asset("12.1.6", { state: "starter" })]),
      release("12.1.6", { tag_name: "Ghidra_12.1.6_beta" }),
      "not a release", null,
      usable,
    ];
    expect(selectGhidraRelease(candidates).version).toBe("12.1.2");
  });

  it("refuses when nothing qualifies", () => {
    expect(() => selectGhidraRelease([release("12.0.4")])).toThrow(/No official Ghidra 12\.1\.x release/);
    expect(() => selectGhidraRelease({})).toThrow(/Unexpected Ghidra release listing/);
  });

  it("orders versions numerically", () => {
    expect(compareVersions("12.1.10", "12.1.9")).toBeGreaterThan(0);
    expect(compareVersions("12.1", "12.1.0")).toBe(0);
    expect(supportedGhidraVersion("12.1")).toBe(true);
    expect(supportedGhidraVersion("12.1.4")).toBe(true);
    expect(supportedGhidraVersion("12.10")).toBe(false);
    expect(supportedGhidraVersion("12.0.4")).toBe(false);
  });
});

describe("Ghidra platform rules", () => {
  it.each([
    ["darwin", "arm64", "mac_arm_64", false],
    ["darwin", "x64", "mac_x86_64", false],
    ["linux", "x64", "linux_x86_64", true],
    ["linux", "arm64", "linux_arm_64", false],
    ["win32", "x64", "win_x86_64", true],
  ] as const)("maps %s/%s to %s (decompiler bundled: %s)", (platform, arch, directory, bundled) => {
    expect(decompilerDirectory({ platform, arch })).toBe(directory);
    expect(bundlesDecompiler({ platform, arch })).toBe(bundled);
  });

  it("rejects hosts REA does not support", () => {
    for (const host of [{ platform: "win32", arch: "arm64" }, { platform: "linux", arch: "ia32" }, { platform: "freebsd", arch: "x64" }] as const) {
      expect(decompilerDirectory(host)).toBeUndefined();
      expect(decompilerBuildTarget(host)).toBeUndefined();
    }
  });

  it("explains why a system is not offered Ghidra, and offers it everywhere else", () => {
    expect(ghidraHostProblem({ platform: "win32", arch: "arm64" })).toBe("REA supports Ghidra on macOS (x64, arm64), Linux (x64, arm64) and Windows (x64); this machine is win32/arm64.");
    expect(ghidraHostProblem({ platform: "linux", arch: "x64", musl: true })).toContain("this Linux uses musl (Alpine)");
    expect(ghidraHostProblem({ platform: "linux", arch: "arm64", musl: true })).toContain("glibc");
    for (const host of [LINUX, MAC, { platform: "linux", arch: "x64", musl: false }, { platform: "win32", arch: "x64" }, { platform: "darwin", arch: "x64", musl: true }] as const) {
      expect(ghidraHostProblem(host)).toBeUndefined();
    }
  });

  it("builds natively for the host architecture and never inherits the Makefile's x86 defaults", () => {
    expect(decompilerBuildTarget({ platform: "darwin", arch: "arm64" })).toEqual({
      directory: "mac_arm_64", arguments: ["ghidra_opt", "ARCH_TYPE=-arch arm64", "OSDIR=mac_arm_64", "ADDITIONAL_FLAGS=-w"],
    });
    expect(decompilerBuildTarget({ platform: "darwin", arch: "x64" })?.arguments).toEqual(["ghidra_opt", "ADDITIONAL_FLAGS=-w"]);
    expect(decompilerBuildTarget({ platform: "linux", arch: "arm64" })).toEqual({
      directory: "linux_arm_64", arguments: ["ghidra_opt", "ARCH_TYPE=", "OSDIR=linux_arm_64"],
    });
  });

  it("tells each system how to get a toolchain", () => {
    expect(buildToolsHelp(MAC)).toContain("xcode-select --install");
    expect(buildToolsHelp({ platform: "linux", arch: "arm64" })).toContain("build-essential bison");
  });
});

async function fakeGhidra(root: string, options: { version?: string; decompilers?: readonly string[]; headless?: boolean; build?: boolean } = {}): Promise<void> {
  const version = options.version ?? "12.1.4";
  await mkdir(join(root, "Ghidra"), { recursive: true });
  await writeFile(join(root, "Ghidra", "application.properties"), `application.name=Ghidra\napplication.version=${version}\napplication.release.name=PUBLIC\n`);
  await mkdir(join(root, "support"), { recursive: true });
  if (options.headless !== false) {
    await writeFile(join(root, "support", "analyzeHeadless"), "#!/bin/sh\n");
    await writeFile(join(root, "support", "analyzeHeadless.bat"), "@echo off\n");
  }
  for (const entry of options.decompilers ?? []) {
    const name = entry.startsWith("win_") ? "decompile.exe" : "decompile";
    const base = entry.startsWith("build:") ? join(root, "Ghidra", "Features", "Decompiler", "build", "os", entry.slice(6)) : join(root, "Ghidra", "Features", "Decompiler", "os", entry);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, entry.startsWith("build:") && entry.includes("win_") ? "decompile.exe" : name), "binary");
  }
}

describe("Ghidra installation inspection", () => {
  it("accepts a complete installation and reports whether the native decompiler is present", async () => {
    const root = await workspace();
    await fakeGhidra(join(root, "complete"), { decompilers: ["linux_x86_64"] });
    await fakeGhidra(join(root, "bare"));
    await fakeGhidra(join(root, "built"), { decompilers: ["build:linux_x86_64"] });
    expect(await inspectGhidraDirectory(join(root, "complete"), LINUX)).toEqual({ ok: true, dir: join(root, "complete"), version: "12.1.4", decompiler: true });
    expect(await inspectGhidraDirectory(join(root, "bare"), LINUX)).toMatchObject({ ok: true, decompiler: false });
    expect(await inspectGhidraDirectory(join(root, "built"), LINUX)).toMatchObject({ ok: true, decompiler: true });
    expect(await inspectGhidraDirectory(join(root, "complete"), MAC)).toMatchObject({ ok: true, decompiler: false });
  });

  it("uses the Windows launcher and decompiler names on Windows", async () => {
    const root = await workspace();
    await fakeGhidra(root, { decompilers: ["win_x86_64"] });
    await rm(join(root, "support", "analyzeHeadless"));
    expect(await inspectGhidraDirectory(root, { platform: "win32", arch: "x64" })).toMatchObject({ ok: true, decompiler: true });
    expect(await inspectGhidraDirectory(root, LINUX)).toMatchObject({ ok: false, reason: expect.stringContaining("no headless launcher") });
  });

  it("explains why a folder cannot be used", async () => {
    const root = await workspace();
    await fakeGhidra(join(root, "old"), { version: "11.4.3" });
    await fakeGhidra(join(root, "future"), { version: "12.10" });
    await fakeGhidra(join(root, "nolauncher"), { headless: false });
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "noversion.txt"), "x");
    expect(await inspectGhidraDirectory(join(root, "old"), LINUX)).toMatchObject({ ok: false, reason: expect.stringContaining("needs Ghidra 12.1.x") });
    expect(await inspectGhidraDirectory(join(root, "future"), LINUX)).toMatchObject({ ok: false });
    expect(await inspectGhidraDirectory(join(root, "nolauncher"), LINUX)).toMatchObject({ ok: false, reason: expect.stringContaining("headless launcher") });
    expect(await inspectGhidraDirectory(join(root, "empty"), LINUX)).toMatchObject({ ok: false, reason: expect.stringContaining("not an extracted Ghidra release") });
    await writeFile(join(root, "empty", "x"), "");
    await mkdir(join(root, "novers", "Ghidra"), { recursive: true });
    await writeFile(join(root, "novers", "Ghidra", "application.properties"), "application.name=Ghidra\n");
    expect(await inspectGhidraDirectory(join(root, "novers"), LINUX)).toMatchObject({ ok: false, reason: expect.stringContaining("does not declare a Ghidra version") });
  });
});

function ghidraArchive(version: string, options: { decompilers?: readonly string[]; extra?: readonly ArchiveEntry[] } = {}): Buffer {
  const top = `ghidra_${version}_PUBLIC`;
  const entries: ArchiveEntry[] = [
    { name: `${top}/` },
    { name: `${top}/Ghidra/application.properties`, body: `application.version=${version}\n` },
    { name: `${top}/support/analyzeHeadless`, body: "#!/bin/sh\n", mode: 0o755 },
    { name: `${top}/support/analyzeHeadless.bat`, body: "@echo off\n" },
    { name: `${top}/Ghidra/Features/Decompiler/src/decompile/cpp/Makefile`, body: "all:\n" },
    ...(options.decompilers ?? []).map((directory) => ({ name: `${top}/Ghidra/Features/Decompiler/os/${directory}/${directory.startsWith("win_") ? "decompile.exe" : "decompile"}`, body: "binary", mode: 0o755 })),
    ...(options.extra ?? []),
  ];
  return zipArchive(entries);
}

function releaseFor(archive: Buffer, version = "12.1.4"): GhidraRelease {
  return {
    version, tag: `Ghidra_${version}_build`, name: `ghidra_${version}_PUBLIC_20260921.zip`, bytes: archive.length, sha256: sha(archive),
    url: `https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${version}_build/ghidra_${version}_PUBLIC_20260921.zip`,
  };
}

function serve(archive: Buffer, calls: string[] = []): (input: string) => Promise<Response> {
  return async (input) => {
    calls.push(input);
    if (input.startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/blob/ghidra.zip" } });
    return new Response(archive, { headers: { "content-length": String(archive.length) } });
  };
}

async function reaRoot(): Promise<string> {
  const base = await workspace();
  return join(base, "tools", "rea");
}

describe("Ghidra installation", () => {
  it("installs a release that ships its decompiler without building anything", async () => {
    const root = await reaRoot();
    const archive = ghidraArchive("12.1.4", { decompilers: ["linux_x86_64"] });
    const calls: string[] = [];
    const build = vi.fn();
    const phases: string[] = [];
    const result = await installGhidra({ root, release: releaseFor(archive), host: LINUX, fetch: serve(archive, calls), build, onProgress: (progress) => phases.push(progress.phase) });
    const dir = join(engineRoots(root).ghidra, "12.1.4");
    expect(result).toEqual({ ok: true, dir, version: "12.1.4", built: false, changed: true });
    expect(build).not.toHaveBeenCalled();
    expect(new Set(phases)).toEqual(new Set(["downloading", "extracting"]));
    expect(await readFile(join(dir, "Ghidra", "application.properties"), "utf8")).toContain("12.1.4");
    if (process.platform !== "win32") expect((await stat(join(dir, "support", "analyzeHeadless"))).mode & 0o111).not.toBe(0);
    expect(await readEngineSettings(root)).toEqual({ ghidra: { dir, managed: true, version: "12.1.4" } });
    expect(await readdir(engineRoots(root).ghidra)).toEqual(["12.1.4"]);
    const again = await installGhidra({ root, release: releaseFor(archive), host: LINUX, fetch: serve(archive, calls), build });
    expect(again).toMatchObject({ ok: true, changed: false });
    expect(calls).toHaveLength(2);
  });

  it("builds the native decompiler once when the archive lacks it", async () => {
    const root = await reaRoot();
    const archive = ghidraArchive("12.1.4");
    const build = vi.fn(async ({ tree, host }: { tree: string; host: EngineHost }) => {
      expect(host).toEqual(MAC);
      await mkdir(join(tree, "Ghidra", "Features", "Decompiler", "os", "mac_arm_64"), { recursive: true });
      await writeFile(join(tree, "Ghidra", "Features", "Decompiler", "os", "mac_arm_64", "decompile"), "built");
    });
    const result = await installGhidra({ root, release: releaseFor(archive), host: MAC, fetch: serve(archive), build });
    expect(result).toMatchObject({ ok: true, built: true, changed: true });
    expect(build).toHaveBeenCalledOnce();
    expect(await inspectGhidraDirectory(join(engineRoots(root).ghidra, "12.1.4"), MAC)).toMatchObject({ ok: true, decompiler: true });
  });

  it("publishes nothing when the build fails, produces nothing or is unavailable", async () => {
    const archive = ghidraArchive("12.1.4");
    for (const build of [
      async () => { throw new Error("make exploded"); },
      async () => undefined,
    ]) {
      const root = await reaRoot();
      const result = await installGhidra({ root, release: releaseFor(archive), host: MAC, fetch: serve(archive), build });
      expect(result.ok).toBe(false);
      expect(await readEngineSettings(root)).toEqual({});
      expect(await readdir(engineRoots(root).ghidra)).toEqual([]);
    }
  });

  it("refuses a download that does not match its published checksum or version series", async () => {
    const root = await reaRoot();
    const archive = ghidraArchive("12.1.4", { decompilers: ["linux_x86_64"] });
    const tampered = { ...releaseFor(archive), sha256: "0".repeat(64) };
    expect(await installGhidra({ root, release: tampered, host: LINUX, fetch: serve(archive) })).toMatchObject({ ok: false, reason: expect.stringContaining("checksum mismatch") });
    const wrong = ghidraArchive("13.0", { decompilers: ["linux_x86_64"] });
    expect(await installGhidra({ root, release: releaseFor(wrong, "12.1.4"), host: LINUX, fetch: serve(wrong) })).toMatchObject({ ok: false, reason: expect.stringContaining("needs Ghidra 12.1.x") });
    expect(await readEngineSettings(root)).toEqual({});
    expect(await readdir(engineRoots(root).ghidra)).toEqual([]);
  });

  it("refuses an archive that tries to write outside its folder", async () => {
    const root = await reaRoot();
    const archive = ghidraArchive("12.1.4", { decompilers: ["linux_x86_64"], extra: [{ name: "ghidra_12.1.4_PUBLIC/../../escape.txt", body: "x" }] });
    expect(await installGhidra({ root, release: releaseFor(archive), host: LINUX, fetch: serve(archive) })).toMatchObject({ ok: false, reason: expect.stringContaining("Unsafe or unsupported archive") });
    expect(await readdir(dirname(engineRoots(root).ghidra))).not.toContain("escape.txt");
  });

  it("replaces older managed releases and shares a concurrent request", async () => {
    const root = await reaRoot();
    const old = join(engineRoots(root).ghidra, "12.1.0");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "marker"), "old");
    const mine = join(engineRoots(root).ghidra, "my-own-notes");
    await mkdir(mine, { recursive: true });
    const archive = ghidraArchive("12.1.4", { decompilers: ["linux_x86_64"] });
    const calls: string[] = [];
    const options = { root, release: releaseFor(archive), host: LINUX, fetch: serve(archive, calls) };
    const [first, second] = await Promise.all([installGhidra(options), installGhidra(options)]);
    expect(first).toBe(second);
    expect(calls).toHaveLength(2);
    expect(await readdir(engineRoots(root).ghidra)).toEqual(["12.1.4", "my-own-notes"]);
  });

  it("replaces a damaged copy of the same version", async () => {
    const root = await reaRoot();
    const damaged = join(engineRoots(root).ghidra, "12.1.4");
    await mkdir(join(damaged, "Ghidra"), { recursive: true });
    await writeFile(join(damaged, "half-extracted"), "x");
    const archive = ghidraArchive("12.1.4", { decompilers: ["linux_x86_64"] });
    expect(await installGhidra({ root, release: releaseFor(archive), host: LINUX, fetch: serve(archive) })).toMatchObject({ ok: true, changed: true });
    expect(await readdir(engineRoots(root).ghidra)).toEqual(["12.1.4"]);
    await expect(stat(join(damaged, "half-extracted"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(damaged, "Ghidra", "application.properties"), "utf8")).toContain("12.1.4");
  });

  it("clears the leftovers of a crashed install before it starts", async () => {
    const root = await reaRoot();
    const folder = engineRoots(root).ghidra;
    for (const name of [".s-deadbeef", ".staging-0b0e4f0e-8c6c-4a0c-9d57-2f1b5e0d9a11"]) {
      await mkdir(join(folder, name, "t"), { recursive: true });
      await writeFile(join(folder, name, "t", "partial"), "x");
    }
    const archive = ghidraArchive("12.1.4", { decompilers: ["linux_x86_64"] });
    expect(await installGhidra({ root, release: releaseFor(archive), host: LINUX, fetch: serve(archive) })).toMatchObject({ ok: true });
    expect(await readdir(folder)).toEqual(["12.1.4"]);
  });

  it("refuses a musl Linux before downloading anything", async () => {
    const root = await reaRoot();
    const archive = ghidraArchive("12.1.4", { decompilers: ["linux_x86_64"] });
    const calls: string[] = [];
    const result = await installGhidra({ root, release: releaseFor(archive), host: { platform: "linux", arch: "x64", musl: true }, fetch: serve(archive, calls) });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("uses musl") });
    expect(calls).toEqual([]);
    await expect(readdir(engineRoots(root).ghidra)).rejects.toThrow();
  });

  it("tells a Windows user whose data folder is too deep to move it, before downloading anything", async () => {
    const root = join(await workspace(), "a".repeat(160), "tools", "rea");
    const archive = ghidraArchive("12.1.4", { decompilers: ["linux_x86_64"] });
    const calls: string[] = [];
    const result = await installGhidra({ root, release: releaseFor(archive), host: { platform: "win32", arch: "x64" }, fetch: serve(archive, calls) });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/too deep for Windows.*CLAI_DATA_DIR/) });
    expect(calls).toEqual([]);
    await expect(readdir(engineRoots(root).ghidra)).rejects.toThrow();
  });

  it("stops without leaving files when cancelled", async () => {
    const root = await reaRoot();
    const archive = ghidraArchive("12.1.4", { decompilers: ["linux_x86_64"] });
    const controller = new AbortController();
    controller.abort(new Error("cancelled by the user"));
    const result = await installGhidra({ root, release: releaseFor(archive), host: LINUX, fetch: serve(archive), signal: controller.signal });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("cancelled") });
    expect(await readEngineSettings(root)).toEqual({});
  });
});

describe.skipIf(process.platform === "win32")("building the native decompiler", () => {
  async function toolchain(script: string): Promise<string> {
    const bin = await workspace();
    await writeFile(join(bin, "make"), `#!/bin/sh\n${script}\n`);
    await chmod(join(bin, "make"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
    return bin;
  }

  async function tree(): Promise<string> {
    const root = await workspace();
    await mkdir(join(root, "Ghidra", "Features", "Decompiler", "src", "decompile", "cpp"), { recursive: true });
    return root;
  }

  const host: EngineHost = { platform: "linux", arch: "arm64" };

  it("runs make with architecture overrides, installs the result and removes build leftovers", async () => {
    const log = join(await workspace(), "args.txt");
    vi.stubEnv("FAKE_MAKE_LOG", log);
    await toolchain('echo "$@" > "$FAKE_MAKE_LOG"\ntouch a.o b.o\nprintf built > ghidra_opt');
    const root = await tree();
    const progress: string[] = [];
    await buildGhidraDecompiler({ tree: root, host, signal: undefined, onProgress: (event) => progress.push(event.phase), missing: async () => [] });
    const executable = join(root, "Ghidra", "Features", "Decompiler", "os", "linux_arm_64", "decompile");
    expect(await readFile(executable, "utf8")).toBe("built");
    expect((await stat(executable)).mode & 0o111).not.toBe(0);
    expect((await readFile(log, "utf8")).trim()).toMatch(/^-j \d+ ghidra_opt ARCH_TYPE= OSDIR=linux_arm_64$/);
    expect(await readdir(join(root, "Ghidra", "Features", "Decompiler", "src", "decompile", "cpp"))).toEqual([]);
    expect(progress).toEqual(["building"]);
  });

  it("reports the end of make's output when the build fails", async () => {
    await toolchain('echo "compiling sleigh" >&2\necho "error: boom" >&2\nexit 2');
    await expect(buildGhidraDecompiler({ tree: await tree(), host, signal: undefined, onProgress: undefined, missing: async () => [] })).rejects.toThrow(/make exited with 2[\s\S]*error: boom/);
  });

  it("names the missing tools and how to install them before starting", async () => {
    await expect(buildGhidraDecompiler({ tree: await tree(), host, signal: undefined, onProgress: undefined, missing: async () => ["bison"] }))
      .rejects.toThrow(/needs bison\. Install a C\+\+ toolchain, make and bison/);
    await expect(buildGhidraDecompiler({ tree: await tree(), host: { platform: "freebsd", arch: "x64" }, signal: undefined, onProgress: undefined }))
      .rejects.toThrow(/no native decompiler for freebsd\/x64/);
  });

  it("stops make when cancelled", async () => {
    await toolchain("sleep 30");
    const controller = new AbortController();
    const running = buildGhidraDecompiler({ tree: await tree(), host, signal: controller.signal, onProgress: undefined, missing: async () => [] });
    setTimeout(() => controller.abort(new Error("cancelled by the user")), 100);
    await expect(running).rejects.toThrow("cancelled by the user");
  });
});
