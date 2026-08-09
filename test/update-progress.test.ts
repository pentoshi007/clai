import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadBinary,
  installDirectBinary,
  type UpdateProgress,
} from "../src/commands/update-install.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function streamingResponse(body: Buffer, withLength: boolean): Response {
  const chunks = [body.subarray(0, 4), body.subarray(4, 9), body.subarray(9)];
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-length" && withLength
          ? String(body.byteLength)
          : null,
    },
    body: {
      getReader() {
        let index = 0;
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            const value = Uint8Array.from(chunks[index]!);
            index += 1;
            return { done: false, value };
          },
        };
      },
    },
    arrayBuffer: async () => Uint8Array.from(body),
  } as unknown as Response;
}

describe("downloadBinary progress", () => {
  it("reports received and total bytes while streaming", async () => {
    const payload = Buffer.from("MOCK-CLAI-BINARY");
    globalThis.fetch = (async () =>
      streamingResponse(payload, true)) as unknown as typeof fetch;

    const seen: Array<{ receivedBytes: number; totalBytes?: number | undefined }> = [];
    const result = await downloadBinary("https://example.test/bin", 5_000, (p) =>
      seen.push(p),
    );

    expect(result.equals(payload)).toBe(true);
    expect(seen[0]).toEqual({ receivedBytes: 0, totalBytes: payload.byteLength });
    expect(seen.at(-1)).toEqual({
      receivedBytes: payload.byteLength,
      totalBytes: payload.byteLength,
    });
    expect(seen.map((p) => p.receivedBytes)).toEqual([0, 4, 9, payload.byteLength]);
  });

  it("still streams when the server omits content-length", async () => {
    const payload = Buffer.from("MOCK-CLAI-BINARY");
    globalThis.fetch = (async () =>
      streamingResponse(payload, false)) as unknown as typeof fetch;

    const seen: Array<{ totalBytes?: number | undefined }> = [];
    const result = await downloadBinary("https://example.test/bin", 5_000, (p) =>
      seen.push(p),
    );

    expect(result.equals(payload)).toBe(true);
    expect(seen.every((p) => p.totalBytes === undefined)).toBe(true);
  });

  it("falls back to a buffered download when no progress callback is given", async () => {
    const payload = Buffer.from("MOCK-CLAI-BINARY");
    globalThis.fetch = (async () =>
      streamingResponse(payload, true)) as unknown as typeof fetch;

    const result = await downloadBinary("https://example.test/bin", 5_000);
    expect(result.equals(payload)).toBe(true);
  });
});

describe("installDirectBinary progress phases", () => {
  it("emits downloading, verifying and installing in order", async () => {
    const payload = Buffer.from("MOCK-CLAI-BINARY");
    const checksum = createHash("sha256").update(payload).digest("hex");
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith(".sha256")) {
        const sum = Buffer.from(`${checksum}  clai-bun-darwin-arm64\n`);
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          arrayBuffer: async () => Uint8Array.from(sum),
        } as unknown as Response;
      }
      return streamingResponse(payload, true);
    }) as unknown as typeof fetch;

    const dir = mkdtempSync(join(tmpdir(), "clai-progress-test-"));
    const target = join(dir, "clai-test");
    writeFileSync(target, "OLD");

    const phases: UpdateProgress["phase"][] = [];
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
      onProgress: (progress) => {
        if (phases.at(-1) !== progress.phase) phases.push(progress.phase);
      },
    });

    expect(result.ok).toBe(true);
    expect(phases).toEqual(["downloading", "verifying", "installing"]);
  });
});
