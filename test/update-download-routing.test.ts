import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  currentPlatformTarget,
  DEFAULT_MIRROR_BASE,
  installDirectBinary,
  mirrorBaseUrl,
} from "../src/commands/update-install.js";

const PAYLOAD = Buffer.from("clai-binary-bytes");
const DIGEST = createHash("sha256").update(PAYLOAD).digest("hex");

let root = "";
let execPath = "";
let requested: string[] = [];
let failMirrorBinary = false;

function stubNetwork(): void {
  vi.stubGlobal("fetch", async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    const isMirror = url.startsWith(mirrorBaseUrl());
    if (url.endsWith(".sha256")) {
      return new Response(`${DIGEST}  asset\n`, { status: 200 });
    }
    if (isMirror && failMirrorBinary) {
      return new Response("nope", { status: 404 });
    }
    return new Response(new Uint8Array(PAYLOAD), {
      status: 200,
      headers: { "content-length": String(PAYLOAD.byteLength) },
    });
  });
}

async function install() {
  return installDirectBinary({
    version: "4.6.1",
    method: { type: "binary" },
    target: currentPlatformTarget("darwin", "arm64"),
    execPath,
    stdio: "pipe",
    log: () => {},
  });
}

beforeEach(() => {
  requested = [];
  failMirrorBinary = false;
  root = mkdtempSync(join(tmpdir(), "clai-mirror-order-"));
  execPath = join(root, "clai");
  writeFileSync(execPath, "old", { mode: 0o755 });
  stubNetwork();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CLAI_NO_MIRROR;
  delete process.env.CLAI_DOWNLOAD_BASE;
  rmSync(root, { recursive: true, force: true });
});

describe("update download routing", () => {
  it("asks Cloudflare for the binary before GitHub", async () => {
    const result = await install();
    expect(result.ok).toBe(true);

    const binaryRequests = requested.filter((url) => !url.endsWith(".sha256"));
    expect(binaryRequests[0]).toContain(DEFAULT_MIRROR_BASE);
    expect(binaryRequests[0]).toContain("/v4.6.1/clai-bun-darwin-arm64");
    expect(binaryRequests).toHaveLength(1);
  });

  it("anchors the checksum on GitHub so a bad mirror cannot self-certify", async () => {
    await install();

    const sumRequests = requested.filter((url) => url.endsWith(".sha256"));
    expect(sumRequests[0]).toContain("github.com");
    expect(sumRequests[0]).not.toContain(DEFAULT_MIRROR_BASE);
  });

  it("falls back to GitHub for the binary when the mirror misses", async () => {
    failMirrorBinary = true;
    const result = await install();
    expect(result.ok).toBe(true);

    const binaryRequests = requested.filter((url) => !url.endsWith(".sha256"));
    expect(binaryRequests[0]).toContain(DEFAULT_MIRROR_BASE);
    expect(binaryRequests[1]).toContain("github.com");
  });

  it("skips the mirror entirely when CLAI_NO_MIRROR=1", async () => {
    process.env.CLAI_NO_MIRROR = "1";
    await install();
    expect(requested.every((url) => !url.startsWith(DEFAULT_MIRROR_BASE))).toBe(
      true,
    );
  });

  it("honours a custom CLAI_DOWNLOAD_BASE for the binary", async () => {
    process.env.CLAI_DOWNLOAD_BASE = "https://mirror.example.test/";
    await install();

    const binaryRequests = requested.filter((url) => !url.endsWith(".sha256"));
    expect(binaryRequests[0]).toBe(
      "https://mirror.example.test/v4.6.1/clai-bun-darwin-arm64",
    );
  });
});
