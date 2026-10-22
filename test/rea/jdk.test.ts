import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c } from "tar";
import { afterEach, describe, expect, it, vi } from "vitest";
import { engineRoots, readEngineSettings } from "../../src/rea/engines.js";
import { installJdk, javaExecutable, javaHomeIn, resolveJdkRelease, selectTemurinRelease, temurinQuery, type JdkRelease } from "../../src/rea/jdk.js";
import { zipArchive } from "../helpers/zip-archive.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clai-jdk-"));
  directories.push(path);
  return path;
}

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const PREFIX = "https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/";

const asset = (overrides: Record<string, unknown> = {}, pkg: Record<string, unknown> = {}) => ({
  release_name: "jdk-21.0.12.1+1",
  binary: { package: { name: "OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz", link: `${PREFIX}OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz`, checksum: "b".repeat(64), size: 200_073_404, ...pkg } },
  ...overrides,
});

describe("portable JDK selection", () => {
  it.each([
    ["darwin", "arm64", { os: "mac", architecture: "aarch64" }],
    ["darwin", "x64", { os: "mac", architecture: "x64" }],
    ["linux", "x64", { os: "linux", architecture: "x64" }],
    ["linux", "arm64", { os: "linux", architecture: "aarch64" }],
    ["win32", "x64", { os: "windows", architecture: "x64" }],
  ] as const)("asks Adoptium for %s/%s", (platform, arch, expected) => {
    expect(temurinQuery({ platform, arch })).toEqual(expected);
  });

  it("offers nothing where Temurin has no suitable build", () => {
    expect(temurinQuery({ platform: "win32", arch: "arm64" })).toBeUndefined();
    expect(temurinQuery({ platform: "linux", arch: "x64" }, true)).toBeUndefined();
    expect(temurinQuery({ platform: "freebsd", arch: "x64" })).toBeUndefined();
    expect(temurinQuery({ platform: "linux", arch: "ia32" })).toBeUndefined();
  });

  it("accepts only official release assets with a checksum and a sensible size", () => {
    expect(selectTemurinRelease([asset()])).toEqual({
      name: "jdk-21.0.12.1+1", url: `${PREFIX}OpenJDK21U-jdk_aarch64_mac_hotspot_21.0.12.1_1.tar.gz`, bytes: 200_073_404, sha256: "b".repeat(64), format: "tar.gz",
    });
    expect(selectTemurinRelease([asset({}, { name: "jdk.zip", link: `${PREFIX}jdk.zip` })]).format).toBe("zip");
    for (const bad of [
      asset({}, { link: "https://evil.test/jdk.tar.gz" }),
      asset({}, { link: "https://github.com/adoptium/temurin17-binaries/releases/download/x/jdk.tar.gz" }),
      asset({}, { checksum: "xyz" }),
      asset({}, { size: 1_000 }),
      asset({}, { size: 5_000_000_000 }),
      asset({}, { name: "jdk.pkg" }),
      asset({ release_name: "jdk-17.0.1+1" }),
      asset({ release_name: "jdk-21 && rm" }),
      { release_name: "jdk-21.0.1", binary: {} },
      "nope",
    ]) {
      expect(() => selectTemurinRelease([bad])).toThrow(/No official Temurin 21 JDK/);
    }
    expect(() => selectTemurinRelease({})).toThrow(/Unexpected JDK release listing/);
  });

  it("resolves through the Adoptium API and explains unsupported systems", async () => {
    const seen: string[] = [];
    const fetcher = async (input: string): Promise<Response> => {
      seen.push(input);
      return new Response(JSON.stringify([asset()]));
    };
    const found = await resolveJdkRelease({ platform: "darwin", arch: "arm64" }, { fetch: fetcher });
    expect(found).toMatchObject({ ok: true, release: { name: "jdk-21.0.12.1+1" } });
    expect(seen).toEqual(["https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=aarch64&image_type=jdk&os=mac&vendor=eclipse"]);
    const unsupported = await resolveJdkRelease({ platform: "win32", arch: "arm64" }, { fetch: fetcher });
    expect(unsupported).toMatchObject({ ok: false, reason: expect.stringContaining("/rea engines use java") });
    const musl = await resolveJdkRelease({ platform: "linux", arch: "x64" }, { fetch: fetcher, musl: true });
    expect(musl).toMatchObject({ ok: false, reason: expect.stringContaining("musl") });
    expect(await resolveJdkRelease({ platform: "linux", arch: "x64", musl: true }, { fetch: fetcher })).toMatchObject({ ok: false, reason: expect.stringContaining("musl") });
    expect(seen).toHaveLength(1);
  });

  it("locates JAVA_HOME inside each platform's layout", () => {
    expect(javaHomeIn("/jdk", "darwin")).toBe(join("/jdk", "Contents", "Home"));
    expect(javaHomeIn("/jdk", "linux")).toBe("/jdk");
    expect(javaExecutable("/jdk", "win32")).toBe(join("/jdk", "bin", "java.exe"));
    expect(javaExecutable("/jdk", "linux")).toBe(join("/jdk", "bin", "java"));
  });
});

async function tarball(files: Record<string, string>): Promise<Buffer> {
  const base = await workspace();
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(base, "src", name, ".."), { recursive: true });
    await writeFile(join(base, "src", name), body);
  }
  const file = join(base, "jdk.tar.gz");
  await c({ gzip: true, file, cwd: join(base, "src") }, [...new Set(Object.keys(files).map((name) => name.split("/")[0]!))]);
  return readFile(file);
}

function releaseOf(archive: Buffer, format: JdkRelease["format"]): JdkRelease {
  return { name: "jdk-21.0.12.1+1", url: `${PREFIX}jdk.${format}`, bytes: archive.length, sha256: sha(archive), format };
}

function serve(archive: Buffer, calls: string[] = []): (input: string) => Promise<Response> {
  return async (input) => {
    calls.push(input);
    if (input.startsWith("https://github.com/")) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/blob/jdk" } });
    return new Response(archive, { headers: { "content-length": String(archive.length) } });
  };
}

const rootOf = async (): Promise<string> => join(await workspace(), "tools", "rea");

describe("portable JDK installation", () => {
  it("installs a tar.gz JDK on macOS with JAVA_HOME at Contents/Home and removes older copies", async () => {
    const root = await rootOf();
    const old = join(engineRoots(root).java, "jdk-21.0.1+12");
    await mkdir(old, { recursive: true });
    await mkdir(join(engineRoots(root).java, "my-own-notes"), { recursive: true });
    const archive = await tarball({ "jdk-21.0.12.1+1/Contents/Home/bin/java": "#!/bin/sh\n", "jdk-21.0.12.1+1/Contents/Home/release": "JAVA_VERSION=21\n" });
    const probe = vi.fn(async () => "21.0.12.1");
    const result = await installJdk({ root, release: releaseOf(archive, "tar.gz"), host: { platform: "darwin", arch: "arm64" }, fetch: serve(archive), probe });
    const home = join(engineRoots(root).java, "jdk-21.0.12.1+1", "Contents", "Home");
    expect(result).toEqual({ ok: true, home, version: "21.0.12.1", changed: true });
    expect(probe).toHaveBeenCalledWith(expect.stringContaining(join("t", "Contents", "Home")), "darwin");
    expect(await readFile(join(home, "release"), "utf8")).toContain("JAVA_VERSION");
    expect(await readEngineSettings(root)).toEqual({ java: { home, managed: true, version: "jdk-21.0.12.1+1" } });
    expect(await readdir(engineRoots(root).java)).toEqual(["jdk-21.0.12.1+1", "my-own-notes"]);
  });

  it("installs a zip JDK on Windows and Linux layouts with JAVA_HOME at the top", async () => {
    const archive = zipArchive([
      { name: "jdk-21.0.12.1+1/" },
      { name: "jdk-21.0.12.1+1/bin/java.exe", body: "MZ" },
      { name: "jdk-21.0.12.1+1/release", body: "JAVA_VERSION=21\n" },
    ]);
    const root = await rootOf();
    const result = await installJdk({ root, release: releaseOf(archive, "zip"), host: { platform: "win32", arch: "x64" }, fetch: serve(archive), probe: async () => "21.0.12" });
    expect(result).toMatchObject({ ok: true, home: join(engineRoots(root).java, "jdk-21.0.12.1+1") });
    expect(await readFile(join(engineRoots(root).java, "jdk-21.0.12.1+1", "bin", "java.exe"), "utf8")).toBe("MZ");
  });

  it("reuses a working install without downloading again", async () => {
    const archive = zipArchive([{ name: "jdk-21.0.12.1+1/bin/java", body: "x" }]);
    const root = await rootOf();
    const calls: string[] = [];
    const options = { root, release: releaseOf(archive, "zip"), host: { platform: "linux", arch: "x64" } as const, fetch: serve(archive, calls), probe: async () => "21.0.12" };
    expect(await installJdk(options)).toMatchObject({ ok: true, changed: true });
    expect(await installJdk(options)).toMatchObject({ ok: true, changed: false });
    expect(calls).toHaveLength(2);
  });

  it("publishes nothing when the JDK cannot run here or the download is wrong", async () => {
    const archive = zipArchive([{ name: "jdk-21.0.12.1+1/bin/java", body: "x" }]);
    const root = await rootOf();
    const host = { platform: "linux", arch: "x64" } as const;
    expect(await installJdk({ root, release: releaseOf(archive, "zip"), host, fetch: serve(archive), probe: async () => undefined }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("does not run on linux/x64") });
    expect(await installJdk({ root, release: { ...releaseOf(archive, "zip"), sha256: "0".repeat(64) }, host, fetch: serve(archive), probe: async () => "21" }))
      .toMatchObject({ ok: false, reason: expect.stringContaining("checksum mismatch") });
    expect(await readEngineSettings(root)).toEqual({});
    expect(await readdir(engineRoots(root).java)).toEqual([]);
  });

  it("replaces a damaged copy of the same version", async () => {
    const root = await rootOf();
    const damaged = join(engineRoots(root).java, "jdk-21.0.12.1+1");
    await mkdir(join(damaged, "bin"), { recursive: true });
    await writeFile(join(damaged, "half-extracted"), "x");
    const archive = zipArchive([{ name: "jdk-21.0.12.1+1/bin/java", body: "x" }]);
    expect(await installJdk({ root, release: releaseOf(archive, "zip"), host: { platform: "linux", arch: "x64" }, fetch: serve(archive), probe: async () => "21" })).toMatchObject({ ok: true, changed: true });
    expect(await readdir(engineRoots(root).java)).toEqual(["jdk-21.0.12.1+1"]);
    await expect(stat(join(damaged, "half-extracted"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(damaged, "bin", "java"), "utf8")).toBe("x");
  });

  it("clears the leftovers of a crashed install before it starts", async () => {
    const root = await rootOf();
    const folder = engineRoots(root).java;
    for (const name of [".s-deadbeef", ".staging-0b0e4f0e-8c6c-4a0c-9d57-2f1b5e0d9a11"]) {
      await mkdir(join(folder, name, "t"), { recursive: true });
      await writeFile(join(folder, name, "t", "partial"), "x");
    }
    const archive = zipArchive([{ name: "jdk-21.0.12.1+1/bin/java", body: "x" }]);
    expect(await installJdk({ root, release: releaseOf(archive, "zip"), host: { platform: "linux", arch: "x64" }, fetch: serve(archive), probe: async () => "21" })).toMatchObject({ ok: true });
    expect(await readdir(folder)).toEqual(["jdk-21.0.12.1+1"]);
  });

  it("tells a Windows user whose data folder is too deep to move it, before downloading anything", async () => {
    const root = join(await workspace(), "a".repeat(200), "tools", "rea");
    const archive = zipArchive([{ name: "jdk-21.0.12.1+1/bin/java.exe", body: "MZ" }]);
    const calls: string[] = [];
    const result = await installJdk({ root, release: releaseOf(archive, "zip"), host: { platform: "win32", arch: "x64" }, fetch: serve(archive, calls), probe: async () => "21" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringMatching(/too deep for Windows.*CLAI_DATA_DIR/) });
    expect(calls).toEqual([]);
    await expect(readdir(engineRoots(root).java)).rejects.toThrow();
  });

  it("refuses archives that expand beyond the allowed size", async () => {
    const root = await rootOf();
    const archive = zipArchive([{ name: "jdk-21.0.12.1+1/bin/java", body: "x", declared: 1_600_000_000 }]);
    const result = await installJdk({ root, release: releaseOf(archive, "zip"), host: { platform: "linux", arch: "x64" }, fetch: serve(archive), probe: async () => "21" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("total size limit") });
  });
});
