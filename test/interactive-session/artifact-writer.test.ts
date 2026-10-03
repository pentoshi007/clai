import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { BoundedArtifactWriter } from "../../src/interactive-session/artifact-writer.js";
import { tempArtifactDir } from "./helpers.js";

let dirs: string[] = [];

function writer(options: { captureBytes?: number; chunkBytes?: number } = {}): BoundedArtifactWriter {
  const directory = tempArtifactDir();
  dirs.push(directory);
  return new BoundedArtifactWriter({
    sessionId: "its_test",
    directory,
    captureBytes: options.captureBytes ?? 1_048_576,
    chunkBytes: options.chunkBytes ?? 64,
    persistenceQueueBytes: 65_536,
    onLimit: "terminate",
  });
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// Feature: interactive-terminal-sessions, Property 16: Artifact rotation and accounting are complete
describe("Property 16: artifact rotation and accounting are complete", () => {
  it("reconstructs captured bytes from ordered chunks with a matching digest", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 90 }),
          { minLength: 1, maxLength: 12 },
        ),
        fc.integer({ min: 1_048_576, max: 2_097_152 }),
        async (chunks, captureBytes) => {
          const artifact = writer({ captureBytes });
          const source: number[] = [];
          for (const chunk of chunks) {
            artifact.append(new Uint8Array(chunk));
            source.push(...chunk);
          }
          await artifact.close();
          const receipt = artifact.receipt();
          expect(receipt.bytes).toBe(source.length);
          expect(receipt.droppedBytes).toBe(0);
          expect(receipt.redacted).toBe(true);
          const rejoined = Buffer.concat(receipt.chunks.map((path) => readFileSync(path)));
          expect(new Uint8Array(rejoined)).toEqual(new Uint8Array(source));
          expect(receipt.sha256).toBe(createHash("sha256").update(rejoined).digest("hex"));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("caps capture and accounts every dropped byte", async () => {
    const artifact = writer({ captureBytes: 1_048_576, chunkBytes: 65_536 });
    const total = 1_048_576 + 500;
    artifact.append(new Uint8Array(total));
    await artifact.close();
    const receipt = artifact.receipt();
    expect(receipt.bytes).toBe(1_048_576);
    expect(receipt.droppedBytes).toBe(500);
    expect(receipt.bytes + receipt.droppedBytes).toBe(total);
    expect(artifact.limitReached).toBe(true);
  });

  it("rotates at the configured chunk size", async () => {
    const artifact = writer({ chunkBytes: 64 });
    artifact.append(new Uint8Array(200));
    await artifact.close();
    const receipt = artifact.receipt();
    expect(receipt.chunks).toHaveLength(4);
    for (const path of receipt.chunks) {
      expect(statSync(path).size).toBeLessThanOrEqual(64);
    }
  });

  it("creates chunk files with owner-only permissions", async () => {
    if (process.platform === "win32") return;
    const artifact = writer();
    artifact.append(new Uint8Array(Buffer.from("data", "utf8")));
    await artifact.close();
    const mode = statSync(artifact.receipt().chunks[0]!).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("names chunks with the opaque id only", async () => {
    const artifact = writer({ chunkBytes: 64 });
    artifact.append(new Uint8Array(200));
    await artifact.close();
    expect(artifact.receipt().chunks.map((path) => basename(path))).toEqual([
      "its_test.log", "its_test.log.1", "its_test.log.2", "its_test.log.3",
    ]);
  });
});
