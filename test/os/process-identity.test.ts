import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProcessIdentityTracker, type ProcessIdentityProvider } from "../../src/os/process-identity.js";

function provider(): ProcessIdentityProvider & { capture: ReturnType<typeof vi.fn>; captureAsync: ReturnType<typeof vi.fn> } {
  return { platform: "test", capture: vi.fn(() => "process-start"), captureAsync: vi.fn(async () => "process-start") };
}

describe("asynchronous process identity", () => {
  it("coalesces concurrent subprocess probes and shares the synchronous cache", async () => {
    const source = provider();
    const tracker = new ProcessIdentityTracker(source, Date.now, () => true);
    const [first, second] = await Promise.all([tracker.captureAsync(10), tracker.captureAsync(10, { refresh: true })]);
    expect(first).toBe(createHash("sha256").update("process-start").digest("hex"));
    expect(second).toBe(first);
    expect(tracker.capture(10)).toBe(first);
    expect(source.captureAsync).toHaveBeenCalledTimes(1);
    expect(source.capture).not.toHaveBeenCalled();
  });

  it("checks cheap liveness before reusing cached identity and refreshes after its TTL", async () => {
    let now = 0;
    let alive = true;
    const source = provider();
    const tracker = new ProcessIdentityTracker(source, () => now, () => alive);
    const identity = await tracker.captureAsync(11);
    for (let i = 0; i < 20; i += 1) expect(await tracker.compareAsync(11, identity, { refresh: false })).toBe("match");
    expect(source.captureAsync).toHaveBeenCalledTimes(1);
    now = 16_000;
    source.captureAsync.mockResolvedValue("reused-pid");
    expect(await tracker.compareAsync(11, identity, { refresh: false })).toBe("mismatch");
    alive = false;
    expect(await tracker.compareAsync(11, identity)).toBe("gone");
    expect(source.captureAsync).toHaveBeenCalledTimes(2);
  });

  it("allows timers and socket callbacks while a slow identity lookup is pending", async () => {
    const source = provider();
    let complete: ((value: string) => void) | undefined;
    source.captureAsync.mockImplementation(() => new Promise<string>((resolve) => { complete = resolve; }));
    const tracker = new ProcessIdentityTracker(source);
    const pending = tracker.captureAsync(12);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(complete).toBeTypeOf("function");
    complete!("process-start");
    expect(await pending).toMatch(/^[a-f0-9]{64}$/);
    expect(source.capture).not.toHaveBeenCalled();
  });

  it("does not repopulate forgotten identities when an old lookup finishes", async () => {
    const source = provider();
    let complete: ((value: string) => void) | undefined;
    source.captureAsync.mockImplementationOnce(() => new Promise<string>((resolve) => { complete = resolve; }));
    const tracker = new ProcessIdentityTracker(source);
    const stale = tracker.captureAsync(13);
    await Promise.resolve();
    tracker.forget(13);
    complete!("old-process");
    await stale;
    const current = await tracker.captureAsync(13);
    expect(current).toBe(createHash("sha256").update("process-start").digest("hex"));
    expect(source.captureAsync).toHaveBeenCalledTimes(2);
  });

  it("retries failed lookups and never treats unavailable evidence as a match", async () => {
    const source = provider();
    source.captureAsync.mockRejectedValueOnce(new Error("probe failed"));
    const tracker = new ProcessIdentityTracker(source, Date.now, () => true);
    await expect(tracker.captureAsync(14)).rejects.toThrow("probe failed");
    expect(await tracker.captureAsync(14)).toMatch(/^[a-f0-9]{64}$/);
    source.captureAsync.mockResolvedValue(undefined);
    expect(await tracker.compareAsync(14, "expected")).toBe("unknown");
    expect(await tracker.compareAsync(undefined, "expected")).toBe("gone");
  });
});
