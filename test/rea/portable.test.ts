import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { c } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadReaNode } from "../../src/rea/node.js";
import { zipFixture } from "../helpers/zip-fixture.js";

let root: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "clai-rea-portable-"));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(root, { recursive: true, force: true });
});

async function archive(prefix: string, file: string, content: string): Promise<Buffer> {
  const input = join(root, "input");
  const path = join(input, prefix, file);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
  const tar = join(root, `${prefix}.tgz`);
  await c({ file: tar, cwd: input, gzip: true }, [prefix]);
  return await readFile(tar);
}

function serve(file: string, bytes: Buffer, extra = new Map<string, Buffer>()): void {
  const sha = createHash("sha256").update(bytes).digest("hex");
  fetchMock.mockImplementation(async (url: URL) => {
    if (url.pathname.endsWith("index.json")) return new Response(JSON.stringify([{ version: "v24.22.0", lts: "Krypton", npm: "11.19.1" }]));
    if (url.pathname.endsWith("SHASUMS256.txt")) return new Response(`${sha}  ${file}\n`);
    if (url.pathname.endsWith(file)) return new Response(bytes);
    const body = extra.get(url.href);
    return body ? new Response(body) : new Response("missing", { status: 404 });
  });
}

describe("REA portable runtime without an OS package manager", () => {
  it.each(["linux", "darwin"] as const)("extracts a verified Node runtime on %s", async (platform) => {
    const file = `node-v24.22.0-${platform}-arm64.tar.gz`;
    const bytes = await archive(`node-v24.22.0-${platform}-arm64`, "bin/node", "portable node");
    serve(file, bytes);
    const installed = await downloadReaNode(join(root, "runtime"), { platform, arch: "arm64" });
    expect(await readFile(installed.node, "utf8")).toBe("portable node");
    expect(installed.npm).toBe(join(root, "runtime", "lib", "node_modules", "npm", "bin", "npm-cli.js"));
  });

  it.each(["x64", "arm64"])("extracts node.exe and a verified matching npm on Windows %s without PowerShell/unzip", async (arch) => {
    const file = `node-v24.22.0-win-${arch}.zip`;
    const bytes = zipFixture([{ name: `node-v24.22.0-win-${arch}/node.exe`, body: "portable node.exe" }]);
    const npm = await archive("package", "bin/npm-cli.js", "portable npm");
    const tarball = "https://registry.npmjs.org/npm/-/npm-11.19.1.tgz";
    const metadata = Buffer.from(JSON.stringify({ name: "npm", version: "11.19.1", dist: {
      tarball, integrity: `sha512-${createHash("sha512").update(npm).digest("base64")}`,
    } }));
    serve(file, bytes, new Map([["https://registry.npmjs.org/npm/11.19.1", metadata], [tarball, npm]]));
    const installed = await downloadReaNode(join(root, "runtime"), { platform: "win32", arch });
    expect(await readFile(installed.node, "utf8")).toBe("portable node.exe");
    expect(await readFile(installed.npm, "utf8")).toBe("portable npm");
  });

  it("refuses a corrupted Node runtime before extraction", async () => {
    serve("node-v24.22.0-linux-arm64.tar.gz", Buffer.from("corrupt"));
    const implementation = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: URL) => url.pathname.endsWith("SHASUMS256.txt")
      ? new Response(`${"0".repeat(64)}  node-v24.22.0-linux-arm64.tar.gz\n`)
      : implementation(url));
    await expect(downloadReaNode(join(root, "runtime"), { platform: "linux", arch: "arm64" })).rejects.toThrow(/checksum mismatch/);
  });

  it("reports unsupported host builds rather than running a mismatched binary", async () => {
    serve("node-v24.22.0-linux-x64.tar.gz", Buffer.from("node"));
    await expect(downloadReaNode(join(root, "runtime"), { platform: "linux", arch: "arm64", musl: true })).rejects.toThrow(/no verified linux-arm64-musl build\. Install Node\.js .*CLAI_REA_NODE/);
  });
});
