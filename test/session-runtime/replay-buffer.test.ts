import { describe, expect, it } from "vitest";
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
});
