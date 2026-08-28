import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  JsonFrameChannel,
  readFirstFrame,
} from "../../src/session-runtime/protocol.js";

describe("session runtime protocol framing", () => {
  it("bounds only the handshake frame and preserves a large replay tail", async () => {
    const stream = new PassThrough() as unknown as Socket;
    const pending = readFirstFrame(stream);
    const replay = Buffer.alloc(128 * 1024, 0x78);
    stream.write(Buffer.concat([
      Buffer.from(`${JSON.stringify({ type: "ack" })}\n`),
      replay,
    ]));
    const first = await pending;
    expect(first.value).toEqual({ type: "ack" });
    expect(first.rest).toEqual(replay);
    stream.destroy();
  });

  it("accepts a batch larger than 64 KiB when every control frame is bounded", () => {
    const stream = new PassThrough() as unknown as Socket;
    const frames = Array.from({ length: 5_000 }, (_, index) =>
      `${JSON.stringify({ type: "ping", index })}\n`,
    );
    const received: unknown[] = [];
    const failed = vi.fn();
    const channel = new JsonFrameChannel(
      stream,
      (value) => received.push(value),
      failed,
      Buffer.from(frames.join("")),
    );
    expect(Buffer.byteLength(frames.join(""))).toBeGreaterThan(64 * 1024);
    expect(received).toHaveLength(5_000);
    expect(failed).not.toHaveBeenCalled();
    channel.dispose();
    stream.destroy();
  });

  it("still rejects one oversized control frame", () => {
    const stream = new PassThrough() as unknown as Socket;
    const failed = vi.fn();
    const channel = new JsonFrameChannel(
      stream,
      () => undefined,
      failed,
      Buffer.from(`${JSON.stringify({ value: "x".repeat(70 * 1024) })}\n`),
    );
    expect(failed).toHaveBeenCalledOnce();
    channel.dispose();
    stream.destroy();
  });
});
