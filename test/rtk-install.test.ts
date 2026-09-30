import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareSemver,
  currentTarget,
  machineOf,
  manualInstructions,
  meetsMinimum,
  operatingSystem,
  parseChecksums,
  parseSemver,
  pathContains,
  resolveLatestTag,
  verifyChecksum,
} from "../src/tools/rtk/release.js";
import { planInstall, planUpdate } from "../src/tools/rtk/install.js";
import { downloadToFile, RtkDownloadError } from "../src/tools/rtk/download.js";

interface TestServer {
  readonly url: string;
  readonly hits: () => number;
  readonly close: () => Promise<void>;
}

const servers: TestServer[] = [];
const dirs: string[] = [];

async function startServer(handler: (res: import("node:http").ServerResponse) => void): Promise<TestServer> {
  let count = 0;
  const server = createServer((_req, res) => {
    count += 1;
    handler(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const entry: TestServer = {
    url: `http://127.0.0.1:${port}`,
    hits: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(entry);
  return entry;
}

async function workDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rtk-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("rtk release target detection", () => {
  it("maps every supported OS and arch to a documented asset", () => {
    expect(currentTarget("darwin", "x64")?.asset).toBe("rtk-x86_64-apple-darwin.tar.gz");
    expect(currentTarget("darwin", "arm64")?.asset).toBe("rtk-aarch64-apple-darwin.tar.gz");
    expect(currentTarget("linux", "x64")?.asset).toBe("rtk-x86_64-unknown-linux-musl.tar.gz");
    expect(currentTarget("linux", "arm64")?.asset).toBe("rtk-aarch64-unknown-linux-gnu.tar.gz");
    expect(currentTarget("win32", "x64")?.asset).toBe("rtk-x86_64-pc-windows-msvc.zip");
  });

  it("returns undefined for unsupported platforms and arches", () => {
    expect(currentTarget("freebsd", "x64")).toBeUndefined();
    expect(currentTarget("linux", "s390x")).toBeUndefined();
    expect(currentTarget("win32", "arm64")).toBeUndefined();
    expect(operatingSystem("aix")).toBeUndefined();
    expect(machineOf("ppc64")).toBeUndefined();
  });
});

describe("rtk semver handling", () => {
  it("parses and compares versions with and without a v prefix", () => {
    expect(parseSemver("v0.50.0")?.minor).toBe(50);
    expect(compareSemver("0.50.0", "v0.50.0")).toBe(0);
    expect(compareSemver("0.28.2", "0.50.0")).toBe(-1);
    expect(compareSemver("1.0.0", "0.99.0")).toBe(1);
    expect(compareSemver("nonsense", "0.50.0")).toBeUndefined();
  });

  it("treats releases at or ahead of latest as current, but older as outdated", () => {
    expect(compareSemver("0.50.0", "0.50.0")).toBe(0);
    expect(compareSemver("0.51.0", "0.50.0")).toBe(1);
    expect(compareSemver("0.28.2", "0.50.0")).toBe(-1);
  });

  it("enforces the rewrite-capable minimum", () => {
    expect(meetsMinimum("0.23.0")).toBe(true);
    expect(meetsMinimum("0.50.0")).toBe(true);
    expect(meetsMinimum("0.22.9")).toBe(false);
    expect(meetsMinimum(undefined)).toBe(false);
  });
});

describe("rtk checksum verification", () => {
  const digest = "a".repeat(64);
  const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

  it("parses GNU and BSD style checksum files", () => {
    const sums = parseChecksums(`${digest}  rtk-x86_64-unknown-linux-musl.tar.gz\n${digest} *rtk-aarch64-apple-darwin.tar.gz\n`);
    expect([...sums.keys()]).toEqual([
      "rtk-x86_64-unknown-linux-musl.tar.gz",
      "rtk-aarch64-apple-darwin.tar.gz",
    ]);
    expect(sums.get("rtk-aarch64-apple-darwin.tar.gz")).toBe(digest);
  });

  it("accepts a matching digest and rejects mismatches or missing entries", () => {
    const data = Buffer.from("hello rtk");
    const sums = parseChecksums(`${digest}  rtk.tar.gz`);
    expect(verifyChecksum(data, "rtk.tar.gz", sums).ok).toBe(false);
    const real = verifyChecksum(data, "rtk.tar.gz", parseChecksums(`${sha256(data)}  rtk.tar.gz`));
    expect(real.ok).toBe(true);
    expect(verifyChecksum(data, "other.tar.gz", sums).reason).toContain("no published checksum");
  });
});

describe("rtk install method planning", () => {
  const linux = currentTarget("linux", "x64");
  const windows = currentTarget("win32", "x64");

  it("prefers a package manager, then a verified binary, then cargo", () => {
    expect(planInstall(false, linux)).toEqual(["brew", "binary", "cargo"]);
    expect(planInstall(true, windows)).toEqual(["winget", "binary", "cargo"]);
  });

  it("skips the binary step when no build is published for the platform", () => {
    expect(planInstall(false, undefined)).toEqual(["brew", "cargo"]);
    expect(planInstall(true, undefined)).toEqual(["winget", "cargo"]);
  });

  it("updates through the recorded origin but keeps fallbacks", () => {
    expect(planUpdate(false, "brew", linux)).toEqual(["brew", "binary", "cargo"]);
    expect(planUpdate(true, "winget", windows)).toEqual(["winget", "binary", "cargo"]);
    expect(planUpdate(false, "cargo", linux)).toEqual(["cargo"]);
    expect(planUpdate(false, undefined, linux)).toEqual(["binary", "cargo"]);
    expect(planUpdate(false, undefined, undefined)).toEqual(["cargo"]);
  });

  it("never uses a Python/pip route and never uses --break-system-packages", () => {
    const text = manualInstructions(currentTarget("linux", "arm64"));
    expect(text).not.toMatch(/pip|itk-rtk|break-system-packages/i);
    expect(text).toContain("brew install rtk");
    expect(text).toContain("cargo install --git https://github.com/rtk-ai/rtk");
    expect(text).toContain("rtk-aarch64-unknown-linux-gnu.tar.gz");
  });
});

describe("rtk install dir and PATH", () => {
  it("detects whether an install dir is already on PATH", () => {
    expect(pathContains("/home/a/.local/bin", "/usr/bin:/home/a/.local/bin")).toBe(true);
    expect(pathContains("/home/a/.local/bin", "/usr/bin:/bin")).toBe(false);
  });
});

describe("rtk download hardening", () => {
  it("streams a complete download and reports progress", async () => {
    const body = "rtk-binary-payload";
    const server = await startServer((res) => {
      res.writeHead(200, { "content-length": String(body.length) });
      res.end(body);
    });
    const dir = await workDir();
    const file = join(dir, "rtk.tar.gz");
    let lastProgress = 0;
    await downloadToFile(`${server.url}/asset`, file, {
      onProgress: (progress) => {
        lastProgress = Math.max(lastProgress, progress.receivedBytes);
      },
    });
    expect((await readFile(file)).toString("utf8")).toBe(body);
    expect(lastProgress).toBe(body.length);
  });

  it("retries server errors and surfaces a clear failure", async () => {
    const server = await startServer((res) => {
      res.writeHead(500);
      res.end("boom");
    });
    const dir = await workDir();
    await expect(
      downloadToFile(`${server.url}/asset`, join(dir, "rtk.tar.gz"), { attempts: 2 }),
    ).rejects.toThrow(/HTTP 500/);
    expect(server.hits()).toBe(2);
  });

  it("aborts immediately on 404 without retrying", async () => {
    const server = await startServer((res) => {
      res.writeHead(404);
      res.end("missing");
    });
    const dir = await workDir();
    await expect(
      downloadToFile(`${server.url}/asset`, join(dir, "rtk.tar.gz"), { attempts: 5 }),
    ).rejects.toBeInstanceOf(RtkDownloadError);
    expect(server.hits()).toBe(1);
  });

  it("handles a truncated response without hanging", async () => {
    const server = await startServer((res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write("only-a-little");
      res.destroy();
    });
    const dir = await workDir();
    await expect(
      downloadToFile(`${server.url}/asset`, join(dir, "rtk.tar.gz"), { attempts: 1, idleTimeoutMs: 1_000 }),
    ).rejects.toBeInstanceOf(RtkDownloadError);
  }, 10_000);
});

describe("rtk latest release resolution", () => {
  it("resolves the live latest tag from GitHub", async () => {
    const tag = await resolveLatestTag();
    expect(tag).toMatch(/^v\d+\.\d+\.\d+/);
  }, 30_000);
});
