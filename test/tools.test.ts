import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { httpFetch } from "../src/tools/http.js";

const originalFetch = globalThis.fetch;

describe("tools – http.fetch", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        const target = typeof url === "string" ? url : url.toString();
        if (target.includes("/status/404")) {
          return new Response("not found", {
            status: 404,
            statusText: "Not Found",
          });
        }
        const body = JSON.stringify({
          url: target,
          method: init?.method ?? "GET",
        });
        return new Response(body, { status: 200 });
      },
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns ok and truncates body bytes at maxBytes", async () => {
    // Mock a large body so we can verify the streaming cap kicks in.
    const huge = "a".repeat(10_000);
    globalThis.fetch = vi.fn(
      async () => new Response(huge, { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await httpFetch("https://example.test/get", {
      maxBytes: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(200);
    expect(result.truncated).toBe(true);
    expect(result.output).toMatch(/truncated at 100 bytes/);
  });

  it("refuses non-http(s) schemes", async () => {
    const result = await httpFetch("file:///etc/passwd");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/non-http/i);
  });

  it("refuses an invalid URL", async () => {
    const result = await httpFetch("not a url");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Invalid URL/);
  });

  it("refuses unknown HTTP methods", async () => {
    const result = await httpFetch("https://example.test", {
      method: "TRACE",
    });
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Unsupported HTTP method/);
  });

  it("blocks loopback by default", async () => {
    const result = await httpFetch("http://127.0.0.1/");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/private\/loopback\/metadata/);
  });

  it("blocks RFC1918 private addresses by default", async () => {
    const a = await httpFetch("http://192.168.0.1/");
    expect(a.ok).toBe(false);
    const b = await httpFetch("http://10.0.0.1/");
    expect(b.ok).toBe(false);
    const c = await httpFetch("http://172.16.0.1/");
    expect(c.ok).toBe(false);
  });

  it("blocks cloud metadata endpoint by default", async () => {
    const result = await httpFetch("http://169.254.169.254/latest/meta-data/");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/private\/loopback\/metadata/);
  });

  it("blocks localhost hostname by default", async () => {
    const result = await httpFetch("http://localhost:8080/");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/private\/loopback\/metadata/);
  });

  it("blocks IPv6 loopback by default", async () => {
    const result = await httpFetch("http://[::1]/");
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/private\/loopback\/metadata/);
  });

  it("allows private addresses with iOwnThis=true", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("hi", { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await httpFetch("http://127.0.0.1/", { iOwnThis: true });
    expect(result.ok).toBe(true);
  });

  it("drops the body for HEAD requests", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("should not see this", { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await httpFetch("https://example.test/", { method: "HEAD" });
    expect(result.ok).toBe(true);
    expect(result.output).not.toMatch(/should not see this/);
  });

  it("returns not-ok for 404", async () => {
    const result = await httpFetch("https://example.test/status/404");
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(404);
  });
});

import { shellExec } from "../src/tools/shell.js";
import { fsRead, fsList } from "../src/tools/fs.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fs.read — secret paths and size caps", () => {
  it("refuses to read a path inside ~/.ssh", async () => {
    await expect(fsRead("~/.ssh/id_rsa")).rejects.toThrow(/secret path/i);
  });

  it("refuses to read ~/.clai/keys.json", async () => {
    await expect(fsRead("~/.clai/keys.json")).rejects.toThrow(/secret path/i);
  });

  it("truncates large files at maxBytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-fsread-"));
    const path = join(dir, "big.txt");
    writeFileSync(path, "x".repeat(10_000));
    const result = await fsRead(path, { maxBytes: 100 });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    // 100 bytes of payload + truncation note
    expect(result.output.startsWith("x".repeat(100))).toBe(true);
    expect(result.output).toMatch(/truncated/);
  });
});

describe("fs.list — secret paths and entry caps", () => {
  it("refuses to list ~/.ssh", async () => {
    await expect(fsList("~/.ssh")).rejects.toThrow(/secret path/i);
  });

  it("truncates large directories at maxEntries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-fslist-"));
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(dir, `f${i}.txt`), "x");
    }
    mkdirSync(join(dir, "sub"));
    const result = await fsList(dir, { maxEntries: 5 });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.output).toMatch(/entries omitted/);
  });
});

describe("shellExec live output", () => {
  it("streams chunks via onOutput before the promise resolves", async () => {
    const chunks: string[] = [];
    const result = await shellExec({
      command: "echo hello && echo world",
      onOutput: (chunk) => chunks.push(chunk),
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    // At least one chunk should have arrived live, not just at the end.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toContain("hello");
    expect(chunks.join("")).toContain("world");
  });

  it("reports stderr through the same onOutput stream channel", async () => {
    const events: Array<{ stream: string; text: string }> = [];
    const result = await shellExec({
      command: "echo oops 1>&2",
      onOutput: (chunk, stream) => events.push({ stream, text: chunk }),
      timeoutMs: 5_000,
    });

    expect(result.ok).toBe(true);
    expect(
      events.some((e) => e.stream === "stderr" && e.text.includes("oops")),
    ).toBe(true);
  });
});
