import { describe, expect, it, vi } from "vitest";
import { writeTerminalAndWait } from "../../src/os/terminal-write.js";

describe("writeTerminalAndWait", () => {
  it("does not resolve until the stream reports the write flushed", async () => {
    let callback: (() => void) | undefined;
    const stream = {
      write: vi.fn((_text: string, done?: () => void) => {
        callback = done;
        return true;
      }),
    };
    let settled = false;
    const pending = writeTerminalAndWait("summary", stream, 5_000).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(stream.write).toHaveBeenCalledWith("summary", expect.any(Function));

    callback?.();
    await pending;
    expect(settled).toBe(true);
  });

  it("resolves when the stream throws", async () => {
    await expect(
      writeTerminalAndWait(
        "summary",
        {
          write() {
            throw new Error("closed");
          },
        },
        5_000,
      ),
    ).resolves.toBeUndefined();
  });

  it("uses a bounded fallback when no callback arrives", async () => {
    vi.useFakeTimers();
    try {
      const pending = writeTerminalAndWait("summary", { write: () => true }, 25);
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
