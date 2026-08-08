import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installDirectBinary } from "../src/commands/update-install.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(payload: Buffer, checksum: string): void {
  globalThis.fetch = (async (url: string) => {
    const body = url.endsWith(".sha256")
      ? Buffer.from(`${checksum}  clai-bun-darwin-arm64\n`)
      : payload;
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => Uint8Array.from(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("installDirectBinary", () => {
  it("downloads, verifies checksum, and replaces the executable", async () => {
    const payload = Buffer.from("MOCK-CLAI-BINARY");
    const checksum = createHash("sha256").update(payload).digest("hex");
    stubFetch(payload, checksum);

    const dir = mkdtempSync(join(tmpdir(), "clai-install-test-"));
    const target = join(dir, "clai-test");
    writeFileSync(target, "OLD");

    const result = await installDirectBinary({
      version: "9.9.9",
      method: { type: "binary", detail: "test" },
      target: {
        platform: "darwin",
        arch: "arm64",
        asset: "clai-bun-darwin-arm64",
        file: "clai-bun-darwin-arm64",
      },
      execPath: target,
      repo: "pentoshi007/clai",
    });

    expect(result.ok).toBe(true);
    expect(result.method).toBe("binary");
    expect(result.needsRestart).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("MOCK-CLAI-BINARY");
  });

  it("throws on checksum mismatch without replacing the executable", async () => {
    const payload = Buffer.from("MOCK-CLAI-BINARY");
    stubFetch(payload, "0".repeat(64));

    const dir = mkdtempSync(join(tmpdir(), "clai-install-test-"));
    const target = join(dir, "clai-test");
    writeFileSync(target, "OLD");

    await expect(
      installDirectBinary({
        version: "9.9.9",
        method: { type: "binary", detail: "test" },
        target: {
          platform: "darwin",
          arch: "arm64",
          asset: "clai-bun-darwin-arm64",
          file: "clai-bun-darwin-arm64",
        },
        execPath: target,
        repo: "pentoshi007/clai",
      }),
    ).rejects.toThrow(/checksum mismatch/);

    // Target untouched after a failed install.
    expect(readFileSync(target, "utf8")).toBe("OLD");
  });
});