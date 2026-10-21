import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { allowedHost, downloadFile, fetchJsonValue, fetchText, type FetchFunction } from "../../src/rea/download.js";

const HOSTS = ["github.com", "*.githubusercontent.com"];
const directories: string[] = [];

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "clai-download-"));
  directories.push(path);
  return path;
}

const sha = (body: string | Buffer): string => createHash("sha256").update(body).digest("hex");

function bodyOf(chunks: readonly (string | Buffer)[], options: { never?: boolean } = {}): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(Buffer.from(chunks[index++]!));
        return undefined;
      }
      if (options.never) return new Promise<void>(() => undefined);
      controller.close();
      return undefined;
    },
  });
}

function respond(routes: Record<string, () => Response>, seen: string[] = []): FetchFunction {
  return async (input) => {
    seen.push(input);
    const route = routes[input];
    if (!route) return new Response("not found", { status: 404 });
    return route();
  };
}

function megabyteStream(megabytes: number, onPull: () => void): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull();
      if (sent >= megabytes) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(new Uint8Array(1024 * 1024).fill(sent % 251));
    },
  });
}

describe("download memory", () => {
  it("does not keep the chunks it has already written", async () => {
    const root = await workspace();
    const megabytes = 128;
    collectGarbage();
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = 0;
    let pulls = 0;
    const sample = (): void => {
      pulls += 1;
      if (pulls % 8 !== 0) return;
      collectGarbage();
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    };
    const fetcher: FetchFunction = async () => new Response(megabyteStream(megabytes, sample), { headers: { "content-length": String(megabytes * 1024 * 1024) } });
    const result = await downloadFile("https://github.com/big.bin", join(root, "big.bin"), { hosts: HOSTS, maxBytes: 200 * 1024 * 1024, sha256: undefined, fetch: fetcher });
    expect(result.bytes).toBe(megabytes * 1024 * 1024);
    expect((await stat(join(root, "big.bin"))).size).toBe(megabytes * 1024 * 1024);
    expect(peak - baseline).toBeLessThan(megabytes * 1024 * 1024 * 0.5);
  });

  it("stops reading and releases the stream when cancelled mid-download", async () => {
    const root = await workspace();
    const controller = new AbortController();
    let pulls = 0;
    const fetcher: FetchFunction = async () => new Response(megabyteStream(64, () => { pulls += 1; if (pulls === 3) controller.abort(new Error("cancelled by the user")); }));
    await expect(downloadFile("https://github.com/big.bin", join(root, "big.bin"), { hosts: HOSTS, maxBytes: 200 * 1024 * 1024, fetch: fetcher, signal: controller.signal })).rejects.toThrow("cancelled by the user");
    expect(pulls).toBeLessThan(10);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("rate limiting", () => {
  const limited = (status: number, headers: Record<string, string>): FetchFunction => async () => new Response("{}", { status, headers });

  it("tells the user when GitHub is rate limiting and for how long", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    await expect(fetchText("https://github.com/api", { hosts: HOSTS, maxBytes: 1000, fetch: limited(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset }) }))
      .rejects.toThrow(/HTTP 403 \(github\.com\): github\.com is rate limiting this network; try again in about (10|11) minutes/);
    await expect(fetchText("https://github.com/api", { hosts: HOSTS, maxBytes: 1000, fetch: limited(429, { "retry-after": "90" }) }))
      .rejects.toThrow("try again in about 2 minutes");
    await expect(fetchText("https://github.com/api", { hosts: HOSTS, maxBytes: 1000, fetch: limited(429, {}) }))
      .rejects.toThrow(/HTTP 429 \(github\.com\): github\.com is rate limiting this network$/);
  });

  it("leaves other failures alone", async () => {
    await expect(fetchText("https://github.com/api", { hosts: HOSTS, maxBytes: 1000, fetch: limited(403, { "x-ratelimit-remaining": "12" }) })).rejects.toThrow(/^Request failed: HTTP 403 \(github\.com\)$/);
    await expect(fetchText("https://github.com/api", { hosts: HOSTS, maxBytes: 1000, fetch: limited(500, {}) })).rejects.toThrow(/^Request failed: HTTP 500 \(github\.com\)$/);
  });
});

describe("official downloads", () => {
  it("accepts only https hosts on the allowlist without credentials or ports", () => {
    expect(allowedHost(new URL("https://github.com/a"), HOSTS)).toBe(true);
    expect(allowedHost(new URL("https://release-assets.githubusercontent.com/a"), HOSTS)).toBe(true);
    for (const url of ["http://github.com/a", "https://evil.test/a", "https://githubusercontent.com.evil.test/a", "https://user:pw@github.com/a", "https://github.com:8443/a", "https://notgithub.com/a"]) {
      expect(allowedHost(new URL(url), HOSTS)).toBe(false);
    }
  });

  it("follows validated redirects, verifies the checksum and reports progress", async () => {
    const root = await workspace();
    const payload = Buffer.alloc(2_500_000, 7);
    const seen: string[] = [];
    const fetcher = respond({
      "https://github.com/o/r/releases/download/t/a.zip": () => new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/blob/a.zip?sig=1" } }),
      "https://release-assets.githubusercontent.com/blob/a.zip?sig=1": () => new Response(bodyOf([payload.subarray(0, 1_000_000), payload.subarray(1_000_000)]), { headers: { "content-length": String(payload.length) } }),
    }, seen);
    const progress: number[] = [];
    const destination = join(root, "a.zip");
    const result = await downloadFile("https://github.com/o/r/releases/download/t/a.zip", destination, {
      hosts: HOSTS, maxBytes: 10_000_000, sha256: sha(payload), bytes: payload.length, fetch: fetcher,
      onProgress: (received) => progress.push(received),
    });
    expect(result).toEqual({ bytes: payload.length, sha256: sha(payload) });
    expect((await readFile(destination)).equals(payload)).toBe(true);
    expect(seen).toHaveLength(2);
    expect(progress.at(-1)).toBe(payload.length);
    expect(await readdir(root)).toEqual(["a.zip"]);
  });

  it("never follows a redirect to an unofficial host or scheme", async () => {
    const root = await workspace();
    for (const location of ["https://evil.test/a.zip", "http://github.com/a.zip", "https://github.com:444/a.zip"]) {
      const fetcher = respond({ "https://github.com/a.zip": () => new Response(null, { status: 302, headers: { location } }) });
      await expect(downloadFile("https://github.com/a.zip", join(root, "a.zip"), { hosts: HOSTS, maxBytes: 100, fetch: fetcher })).rejects.toThrow(/unofficial download origin/);
    }
    await expect(downloadFile("https://evil.test/a.zip", join(root, "a.zip"), { hosts: HOSTS, maxBytes: 100, fetch: respond({}) })).rejects.toThrow(/unofficial download origin/);
  });

  it("stops after too many redirects and a redirect without a location", async () => {
    const root = await workspace();
    const loop = respond({ "https://github.com/a": () => new Response(null, { status: 302, headers: { location: "https://github.com/a" } }) });
    await expect(downloadFile("https://github.com/a", join(root, "a"), { hosts: HOSTS, maxBytes: 100, fetch: loop })).rejects.toThrow(/redirected more than/);
    const bare = respond({ "https://github.com/a": () => new Response(null, { status: 302 }) });
    await expect(downloadFile("https://github.com/a", join(root, "a"), { hosts: HOSTS, maxBytes: 100, fetch: bare })).rejects.toThrow(/without a location/);
  });

  it("removes partial data when the checksum, size or status is wrong", async () => {
    const root = await workspace();
    const payload = Buffer.from("the real release bytes");
    const ok = respond({ "https://github.com/a": () => new Response(bodyOf([payload]), { headers: { "content-length": String(payload.length) } }) });
    await expect(downloadFile("https://github.com/a", join(root, "a"), { hosts: HOSTS, maxBytes: 1000, sha256: sha("other"), fetch: ok })).rejects.toThrow(/checksum mismatch/);
    await expect(downloadFile("https://github.com/a", join(root, "a"), { hosts: HOSTS, maxBytes: 1000, sha256: sha(payload), bytes: payload.length + 5, fetch: ok })).rejects.toThrow(/does not match the published size/);
    const missing = respond({});
    await expect(downloadFile("https://github.com/a", join(root, "a"), { hosts: HOSTS, maxBytes: 1000, fetch: missing })).rejects.toThrow(/HTTP 404/);
    expect(await readdir(root)).toEqual([]);
  });

  it("refuses downloads larger than allowed whether declared or streamed", async () => {
    const root = await workspace();
    const declared = respond({ "https://github.com/a": () => new Response(bodyOf(["x"]), { headers: { "content-length": "5000" } }) });
    await expect(downloadFile("https://github.com/a", join(root, "a"), { hosts: HOSTS, maxBytes: 1000, fetch: declared })).rejects.toThrow(/exceeds 1000 bytes/);
    const streamed = respond({ "https://github.com/a": () => new Response(bodyOf(["x".repeat(600), "x".repeat(600)])) });
    await expect(downloadFile("https://github.com/a", join(root, "a"), { hosts: HOSTS, maxBytes: 1000, fetch: streamed })).rejects.toThrow(/exceeds 1000 bytes/);
    expect(await readdir(root)).toEqual([]);
  });

  it("gives up on a stalled connection and honours cancellation", async () => {
    const root = await workspace();
    const stalled = respond({ "https://github.com/a": () => new Response(bodyOf(["partial"], { never: true })) });
    await expect(downloadFile("https://github.com/a", join(root, "a"), { hosts: HOSTS, maxBytes: 1000, stallMs: 50, fetch: stalled })).rejects.toThrow(/stalled/);
    const controller = new AbortController();
    controller.abort(new Error("stopped by the user"));
    await expect(downloadFile("https://github.com/a", join(root, "b"), { hosts: HOSTS, maxBytes: 1000, signal: controller.signal, fetch: stalled })).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  it("requires a well-formed checksum when one is supplied", async () => {
    const root = await workspace();
    await expect(downloadFile("https://github.com/a", join(root, "a"), { hosts: HOSTS, maxBytes: 100, sha256: "abc", fetch: respond({}) })).rejects.toThrow(/SHA-256 checksum is required/);
    await expect(stat(join(root, "a"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads bounded text and JSON from allowed hosts only", async () => {
    const fetcher = respond({
      "https://github.com/meta": () => new Response(bodyOf(['{"ok":', "true}"])),
      "https://github.com/big": () => new Response(bodyOf(["x".repeat(900), "x".repeat(900)])),
      "https://github.com/bad": () => new Response(bodyOf(["<html>"])),
    });
    const options = { hosts: HOSTS, maxBytes: 1000, fetch: fetcher };
    expect(await fetchJsonValue("https://github.com/meta", options)).toEqual({ ok: true });
    await expect(fetchText("https://github.com/big", options)).rejects.toThrow(/exceeds 1000 bytes/);
    await expect(fetchJsonValue("https://github.com/bad", options)).rejects.toThrow(/not valid JSON/);
    await expect(fetchText("https://evil.test/meta", options)).rejects.toThrow(/unofficial download origin/);
  });
});
