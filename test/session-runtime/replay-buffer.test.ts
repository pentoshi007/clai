import { describe, expect, it, vi } from "vitest";
import { TerminalReplayBuffer } from "../../src/session-runtime/replay-buffer.js";

describe("TerminalReplayBuffer", () => {
  it("keeps the newest bytes within the configured bound", () => {
    const replay = new TerminalReplayBuffer(8);
    replay.append(Buffer.from("abcd"));
    replay.append(Buffer.from("efghij"));
    expect(replay.byteLength).toBe(8);
    expect(replay.snapshot().toString()).toBe("cdefghij");
  });

  it("truncates a single oversized chunk from the front", () => {
    const replay = new TerminalReplayBuffer(5);
    replay.append(Buffer.from("0123456789"));
    expect(replay.snapshot().toString()).toBe("56789");
    replay.clear();
    expect(replay.byteLength).toBe(0);
  });

  it("rejects invalid limits", () => {
    expect(() => new TerminalReplayBuffer(0)).toThrow(/positive integer/);
  });

  it("reuses bounded storage across many tiny terminal writes", () => {
    const replay = new TerminalReplayBuffer(257);
    const chunk = new Uint8Array(1);
    const allocate = vi.spyOn(Buffer, "allocUnsafe");
    const copy = vi.spyOn(Buffer, "from");
    try {
      for (let index = 0; index < 20_000; index += 1) {
        chunk[0] = index % 256;
        replay.append(chunk);
      }
      expect(allocate).toHaveBeenCalledTimes(1);
      expect(allocate).toHaveBeenCalledWith(257);
      expect(copy).not.toHaveBeenCalled();
    } finally {
      allocate.mockRestore();
      copy.mockRestore();
    }
    expect([...replay.snapshot()]).toEqual(
      Array.from({ length: 257 }, (_, index) => (20_000 - 257 + index) % 256),
    );
  });

  it("copies only retained bytes from oversized chunks and isolates snapshots", () => {
    const replay = new TerminalReplayBuffer(19);
    const chunk = new Uint8Array(1024 * 1024).fill(42);
    const copy = vi.spyOn(Buffer, "from");
    try {
      replay.append(chunk);
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
    }
    chunk.fill(1);
    const snapshot = replay.snapshot();
    expect([...snapshot]).toEqual(Array(19).fill(42));
    replay.append(new Uint8Array([2, 3, 4]));
    expect([...replay.snapshot()]).toEqual([...Array(16).fill(42), 2, 3, 4]);
    expect([...snapshot]).toEqual(Array(19).fill(42));
    replay.clear();
    replay.append(new Uint8Array([5, 6]));
    expect([...replay.snapshot()]).toEqual([5, 6]);
  });
});
