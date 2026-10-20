import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPackage, fetchBytes, npmRelease, officialUrl, verifyIntegrity } from "../../src/rea/distribution.js";

export function tarBytes(path: string, content = "data", type = "0"): Buffer {
  const header = Buffer.alloc(512);
  header.write(path);
  header.write("0000700\0", 100);
  header.write("0000000\0", 108);
  header.write("0000000\0", 116);
  header.write(`${Buffer.byteLength(content).toString(8).padStart(11, "0")}\0`, 124);
  header.write("00000000000\0", 136);
  header.fill(32, 148, 156);
  header.write(type, 156);
  if (type === "2") header.write("../../outside", 157);
  header.write("ustar\0", 257);
  header.write("00", 263);
  header.write(`${header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0")}\0 `, 148);
  return gzipSync(Buffer.concat([header, Buffer.from(content), Buffer.alloc((512 - Buffer.byteLength(content) % 512) % 512), Buffer.alloc(1024)]));
}

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

const directory = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "clai-rea-distribution-"));
  directories.push(path);
  return path;
};

describe("REA verified distribution", () => {
  it("only accepts the two official HTTPS download origins", () => {
    for (const url of ["http://nodejs.org/a", "https://nodejs.org.evil.test/a", "https://evil.test/a", "https://user:pass@nodejs.org/a"]) {
      expect(() => officialUrl(url)).toThrow();
    }
    expect(officialUrl("https://nodejs.org/dist/index.json").hostname).toBe("nodejs.org");
  });

  it("rejects corrupt and weak integrity checksums", () => {
    const bytes = Buffer.from("official package");
    const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
    expect(() => verifyIntegrity(bytes, integrity)).not.toThrow();
    expect(() => verifyIntegrity(Buffer.from("tampered"), integrity)).toThrow(/mismatch/);
    expect(() => verifyIntegrity(bytes, "sha1-abc")).toThrow(/required/);
  });

  it("bounds metadata and streaming downloads and refuses partial responses", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("too large", { headers: { "content-length": "9" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchBytes("https://nodejs.org/test", 5)).rejects.toThrow(/exceeds/);
    fetch.mockResolvedValue(new Response("too large"));
    await expect(fetchBytes("https://nodejs.org/test", 5)).rejects.toThrow(/exceeds/);
    fetch.mockResolvedValue(new Response("abc", { headers: { "content-length": "5" } }));
    await expect(fetchBytes("https://nodejs.org/test", 10)).rejects.toThrow(/Incomplete/);
    expect(fetch.mock.calls[0]?.[1].redirect).toBe("error");
  });

  it("validates package identity and official tarball locations", async () => {
    const metadata = { name: "rea-agents", version: "6.7.0", dist: { tarball: "https://registry.npmjs.org/rea-agents/-/rea-agents-6.7.0.tgz", integrity: "sha512-YQ==" } };
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(metadata)));
    vi.stubGlobal("fetch", fetch);
    expect((await npmRelease("rea-agents")).version).toBe("6.7.0");
    metadata.dist.tarball = "https://registry.npmjs.org/unrelated/-/evil.tgz";
    await expect(npmRelease("rea-agents")).rejects.toThrow(/package URL/);
    metadata.name = "unrelated";
    await expect(npmRelease("rea-agents")).rejects.toThrow(/metadata/);
  });

  it("extracts npm packages without requiring tar or a shell", async () => {
    const destination = await directory();
    await extractPackage(tarBytes("package/bin/npm-cli.js", "console.log('npm')"), destination, "package");
    expect(await readFile(join(destination, "bin", "npm-cli.js"), "utf8")).toContain("console.log");
  });

  it.each(["package/../../escaped", "/absolute/path", "package/C:/escape", "package/..\\escape"])("rejects unsafe archive path %s", async (path) => {
    await expect(extractPackage(tarBytes(path), await directory(), "package")).rejects.toThrow();
  });

  it("does not extract archive symlinks", async () => {
    const destination = await directory();
    await extractPackage(tarBytes("package/link", "", "2"), destination, "package");
    await expect(readFile(join(destination, "link"))).rejects.toThrow();
  });
});
