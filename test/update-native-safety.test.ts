import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBinary, installDirectBinary, type PerformUpdateOptions } from "../src/commands/update-install.js";

const roots: string[] = [];
const payload = Buffer.from("#!/bin/sh\nprintf '9.9.9\\n'\n");
function fixture(): PerformUpdateOptions {
  const root = mkdtempSync(join(tmpdir(), "clai-native-safety-")); roots.push(root);
  const execPath = join(root, "clai");
  writeFileSync(execPath, "#!/bin/sh\nprintf '4.14.4\\n'\n", { mode: 0o755 });
  writeFileSync(join(root, "config"), "preserve");
  return { method: { type: "binary", detail: "fixture", executablePath: execPath }, version: "9.9.9", log: () => {}, stdio: "pipe" };
}
function network(bytes = payload, mirrorBytes = bytes, length = bytes.length): string[] {
  const seen: string[] = [];
  const digest = createHash("sha256").update(bytes).digest("hex");
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = String(input); seen.push(url);
    if (url.endsWith(".sha256")) return new Response(digest + "  asset\n");
    const body = url.startsWith("https://github.com/") ? bytes : mirrorBytes;
    return new Response(new Uint8Array(body), { headers: { "content-length": String(length) } });
  });
  return seen;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bounded downloads", () => {
  it("rejects oversized declared downloads before reading the body", async () => {
    vi.stubGlobal("fetch", async () => new Response("data", { headers: { "content-length": "1000" } }));
    await expect(downloadBinary("https://example.test/asset", 1000, undefined, undefined, 16)).rejects.toThrow(/size limit/);
  });
  it("bounds streamed downloads without content-length", async () => {
    vi.stubGlobal("fetch", async () => new Response("x".repeat(17)));
    await expect(downloadBinary("https://example.test/asset", 1000, undefined, undefined, 16)).rejects.toThrow(/size limit/);
  });
  it("rejects truncated content", async () => {
    vi.stubGlobal("fetch", async () => new Response("data", { headers: { "content-length": "20" } }));
    await expect(downloadBinary("https://example.test/asset")).rejects.toThrow(/incomplete/);
  });
  it("rejects an empty response", async () => {
    vi.stubGlobal("fetch", async () => new Response(""));
    await expect(downloadBinary("https://example.test/asset")).rejects.toThrow(/empty/);
  });
  it("does not make a network request after pre-cancellation", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController(); controller.abort();
    await expect(downloadBinary("https://example.test/asset", 1000, undefined, controller.signal)).rejects.toThrow(/cancelled/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("native promotion and recovery", () => {
  it("retries GitHub when the mirror returns corrupt bytes, not just HTTP failures", async () => {
    const options = fixture(); const seen = network(payload, Buffer.from("corrupt"), 7);
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      const url = String(input); seen.push(url);
      if (url.endsWith(".sha256")) return new Response(createHash("sha256").update(payload).digest("hex"));
      return new Response(new Uint8Array(url.startsWith("https://github.com/") ? payload : Buffer.from("corrupt")));
    });
    const result = await installDirectBinary(options);
    expect(result).toMatchObject({ outcome: "applied", installedVersion: "9.9.9" });
    expect(seen.filter((url) => !url.endsWith(".sha256"))).toHaveLength(2);
  });
  it("updates the canonical executable without destroying its launcher symlink", async () => {
    const options = fixture(); network();
    const alias = options.method.executablePath! + "-alias"; symlinkSync(options.method.executablePath!, alias);
    await installDirectBinary({ ...options, execPath: alias });
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readFileSync(options.method.executablePath!).equals(payload)).toBe(true);
  });
  it("rejects a checksum-valid executable with the wrong version before replacement", async () => {
    const options = fixture(); network(Buffer.from("#!/bin/sh\nprintf '0.0.0\\n'\n"));
    const previous = readFileSync(options.method.executablePath!);
    await expect(installDirectBinary(options)).rejects.toThrow(/verification failed/);
    expect(readFileSync(options.method.executablePath!).equals(previous)).toBe(true);
  });
  it("rolls back an executable that only works in the download staging directory", async () => {
    const options = fixture();
    network(Buffer.from("#!/bin/sh\ncase \"$0\" in *clai-bun-*) printf '9.9.9\\n';; *) printf '0.0.0\\n';; esac\n"));
    const previous = readFileSync(options.method.executablePath!);
    await expect(installDirectBinary(options)).rejects.toThrow(/previous executable restored/);
    expect(readFileSync(options.method.executablePath!).equals(previous)).toBe(true);
    const root = join(options.method.executablePath!, "..");
    expect(readFileSync(join(root, "config"), "utf8")).toBe("preserve");
    expect(readdirSync(root).some((file) => file.includes(".update-"))).toBe(false);
  });
  it("checks cancellation again immediately before promotion", async () => {
    const options = fixture(); network();
    const previous = readFileSync(options.method.executablePath!);
    const controller = new AbortController();
    await expect(installDirectBinary({ ...options, signal: controller.signal, onProgress: (progress) => { if (progress.phase === "installing") controller.abort(); } })).rejects.toThrow(/cancelled/);
    expect(readFileSync(options.method.executablePath!).equals(previous)).toBe(true);
  });
  it("keeps the old binary on partial downloads from both sources", async () => {
    const options = fixture(); network(payload, payload, payload.length + 10);
    const previous = readFileSync(options.method.executablePath!);
    await expect(installDirectBinary(options)).rejects.toThrow(/incomplete/);
    expect(readFileSync(options.method.executablePath!).equals(previous)).toBe(true);
  });
});
