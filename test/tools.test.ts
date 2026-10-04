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
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.output).toMatch(/truncated@100|stopped at 100 bytes/i);
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

  it("captures 404 responses as HTTP evidence instead of tool failures", async () => {
    const result = await httpFetch("https://example.test/status/404");
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("404 Not Found");
  });

  it("does not retry 5xx by default (honest pentest evidence)", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      return new Response("try again", {
        status: 503,
        statusText: "Service Unavailable",
      });
    }) as unknown as typeof fetch;

    const result = await httpFetch("https://example.test/flaky");

    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    expect(result.output).toContain("503");
    expect(result.output).toContain("attempts=1");
    expect(result.output).not.toContain("Metadata:");
  });

  it("retries transient GET failures when retries is set", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        return new Response("try again", {
          status: 503,
          statusText: "Service Unavailable",
        });
      }
      return new Response("<html><main>ready now</main></html>", {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html" },
      });
    }) as unknown as typeof fetch;

    const result = await httpFetch("https://example.test/flaky", { retries: 2 });

    expect(result.ok).toBe(true);
    expect(calls).toBe(3);
    expect(result.output).toContain("attempts=3");
    expect(result.output).toContain("Body:");
    expect(result.output).toContain("ready now");
    // Single body representation — no dual Readable + Raw dump.
    expect(result.output).not.toContain("Readable content:");
    expect(result.output).not.toContain("Raw body:");
    expect(result.output).not.toContain("Metadata:");
  });

  it("keeps every response header even when body is large", async () => {
    const huge = "Z".repeat(50_000);
    globalThis.fetch = vi.fn(async () =>
      new Response(huge, {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "text/plain",
          server: "nginx",
          "x-custom-trace": "trace-abc",
          "x-request-id": "req-1",
          "set-cookie": "sid=xyz; HttpOnly",
          "x-obscure-debug": "keep-me",
        },
      }),
    ) as unknown as typeof fetch;

    const result = await httpFetch("https://example.test/big");
    expect(result.ok).toBe(true);
    // All headers present (not dropped for "noise").
    expect(result.output).toMatch(/server:\s*nginx/i);
    expect(result.output).toMatch(/x-custom-trace:\s*trace-abc/i);
    expect(result.output).toMatch(/x-obscure-debug:\s*keep-me/i);
    expect(result.output).toMatch(/set-cookie:\s*sid=xyz/i);
    expect(result.output).toMatch(/x-request-id:\s*req-1/i);
    // No hidden post-capture body cap: the complete captured body is returned.
    expect(result.output).not.toMatch(/body truncated|wire capture stopped/i);
    expect(result.output.endsWith(huge)).toBe(true);
  });

  it("records redirect chain and hop set-cookie in evidence", async () => {
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL) => {
      const target = typeof url === "string" ? url : url.toString();
      if (target.includes("/start")) {
        return new Response(null, {
          status: 302,
          statusText: "Found",
          headers: {
            location: "https://example.test/final",
            "set-cookie": "session=abc; Path=/",
          },
        });
      }
      return new Response("<html><body>ok</body></html>", {
        status: 200,
        statusText: "OK",
        headers: {
          "content-type": "text/html",
          server: "nginx/1.25",
        },
      });
    }) as unknown as typeof fetch;

    const result = await httpFetch("https://example.test/start");
    expect(result.ok).toBe(true);
    expect(result.output).toMatch(/redirects:/);
    expect(result.output).toMatch(/302/);
    expect(result.output).toMatch(/session=abc|set-cookie/);
    expect(result.output).toMatch(/Tech hints:.*server=nginx/i);
    expect(result.output).toContain("Body:");
  });
});

import { shellExec } from "../src/tools/shell.js";
import { fsRead } from "../src/tools/fs.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("fs.read — size caps (secret-path gate removed)", () => {
  it("does not hard-refuse ~/.ssh (pentest freeness)", async () => {
    // May fail with ENOENT if the file is missing — must not throw "secret path".
    try {
      await fsRead("~/.ssh/id_rsa");
    } catch (err) {
      expect(String(err)).not.toMatch(/secret path/i);
    }
  });

  it("truncates large files at maxBytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-fsread-"));
    const path = join(dir, "big.txt");
    writeFileSync(path, "x".repeat(10_000));
    const result = await fsRead(path, { maxBytes: 100 });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    // Hard maxBytes still caps payload; header may precede the body.
    expect(result.output).toContain("x".repeat(100));
    expect(result.output).not.toContain("x".repeat(101));
    expect(result.output).toMatch(/truncated/i);
  });
});

describe("fs.read — directory entry caps (secret-path gate removed)", () => {
  it("does not hard-refuse listing ~/.ssh", async () => {
    try {
      await fsRead("~/.ssh");
    } catch (err) {
      expect(String(err)).not.toMatch(/secret path/i);
    }
  });

  it("includes hidden entries in a deterministic listing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-directory-read-hidden-"));
    writeFileSync(join(dir, "visible.txt"), "visible");
    writeFileSync(join(dir, ".hidden.txt"), "hidden");

    const result = await fsRead(dir);

    expect(result.ok).toBe(true);
    expect(result.output).toContain("2 entries (1 hidden included)");
    expect(result.output).toContain("file .hidden.txt [hidden]");
    expect(result.output).toContain("file visible.txt");
    expect(result.output.indexOf(".hidden.txt")).toBeLessThan(
      result.output.indexOf("visible.txt"),
    );
  });

  it("truncates large directories at maxEntries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-directory-read-"));
    for (let i = 0; i < 20; i += 1) {
      writeFileSync(join(dir, `f${i}.txt`), "x");
    }
    mkdirSync(join(dir, "sub"));
    const result = await fsRead(dir, { limit: 5 });
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
