import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellExec } from "../src/tools/shell.js";

describe("phase 3 — bounded shell capture", () => {
  it("RingBuffer trims a single oversized chunk to capacity (Windows regression)", async () => {
    // On Windows, Node delivers the entire stdout as one chunk; the original
    // ring buffer kept the whole thing because of the `chunks.length > 1`
    // guard. Trim immediately when a single chunk overflows.
    const { RingBuffer } = await import("../src/tools/shell.js");
    const ring = new RingBuffer(1_000);
    ring.push("a".repeat(200_000));
    expect(ring.size()).toBeLessThanOrEqual(1_000);
    expect(ring.toString().length).toBeLessThanOrEqual(1_000);
  });

  it("RingBuffer keeps the tail when many small chunks arrive", async () => {
    const { RingBuffer } = await import("../src/tools/shell.js");
    const ring = new RingBuffer(50);
    for (let i = 0; i < 100; i += 1) ring.push(`x${i.toString().padStart(2, "0")}`);
    expect(ring.size()).toBeLessThanOrEqual(50);
    // Last chunks should still be visible.
    expect(ring.toString()).toContain("x99");
  });

  it("keeps the in-memory output bounded by maxModelBytes even for large stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-shell-bounded-"));
    const artifactPath = join(dir, "out.txt");
    // 200KB of 'a' followed by 'END' so we can verify head + tail both survive.
    const result = await shellExec({
      command: 'node -e "process.stdout.write(\\"a\\".repeat(200000)); process.stdout.write(\\"\\nEND\\\\n\\");"',
      maxModelBytes: 4_000,
      artifactPath,
      timeoutMs: 10_000,
    });
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(6_000); // some overhead for truncation note
    expect(result.truncated).toBe(true);
    expect(result.stats?.bytesRead).toBeGreaterThan(199_000);
    expect(result.stats?.bytesDropped).toBeGreaterThan(0);
    // Tail should still surface the END marker.
    expect(result.output).toMatch(/END/);
    // Artifact should hold the full output.
    expect(existsSync(artifactPath)).toBe(true);
    const raw = readFileSync(artifactPath, "utf8");
    expect(raw.length).toBeGreaterThan(199_000);
    unlinkSync(artifactPath);
  });

  it("kills the child when maxCaptureBytes is exceeded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "clai-shell-cap-"));
    const artifactPath = join(dir, "cap.txt");
    const result = await shellExec({
      // Generate an unbounded stream so the cap kicks in deterministically.
      command: 'node -e "setInterval(() => process.stdout.write(\\"x\\".repeat(8192)), 1);"',
      maxModelBytes: 4_000,
      maxCaptureBytes: 100_000,
      onLimit: "terminate",
      artifactPath,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(false);
    expect(result.stats?.captureLimitHit).toBe(true);
    expect(result.exitCode === 137 || result.exitCode === 130).toBe(true);
    expect(existsSync(artifactPath)).toBe(true);
    unlinkSync(artifactPath);
  });

  it("returns stats with bytesRead/linesRead/elapsedMs", async () => {
    const result = await shellExec({
      command: 'node -e "for (let i = 0; i < 5; i++) console.log(\\"line\\" + i);"',
      noArtifact: true,
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(result.stats?.linesRead).toBeGreaterThanOrEqual(5);
    expect(result.stats?.bytesRead).toBeGreaterThan(0);
    expect(result.stats?.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
