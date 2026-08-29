import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { startNoninteractive } from "../../src/noninteractive/start-noninteractive.js";
import {
  installNoninteractiveCancellation,
  type CancellationInput,
  type CancellationProcess,
} from "../../src/noninteractive/cancellation.js";

class FakeInput extends EventEmitter implements CancellationInput {
  isTTY = true;
  isRaw = false;
  readonly rawModes: boolean[] = [];
  resumed = 0;

  setRawMode(mode: boolean): void {
    this.isRaw = mode;
    this.rawModes.push(mode);
  }

  resume(): this {
    this.resumed += 1;
    return this;
  }
}

class FakeProcess extends EventEmitter implements CancellationProcess {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.on(event, listener);
  }

  off(event: "SIGINT" | "SIGTERM", listener: () => void): this {
    return super.off(event, listener);
  }
}

describe("noninteractive cancellation", () => {
  it("puts TTY input in raw mode and aborts on Escape", () => {
    const input = new FakeInput();
    const proc = new FakeProcess();
    const abort = vi.fn();
    const dispose = installNoninteractiveCancellation({ input, proc, abort });

    input.emit("data", Buffer.from([0x1b]));

    expect(input.rawModes).toEqual([true]);
    expect(input.resumed).toBe(1);
    expect(abort).toHaveBeenCalledOnce();
    dispose();
    expect(input.rawModes).toEqual([true, false]);
  });

  it("aborts on a raw Ctrl+C byte", () => {
    const input = new FakeInput();
    const abort = vi.fn();
    const dispose = installNoninteractiveCancellation({
      input,
      proc: new FakeProcess(),
      abort,
    });

    input.emit("data", Buffer.from([0x03]));

    expect(abort).toHaveBeenCalledOnce();
    dispose();
  });

  it("aborts on SIGINT and SIGTERM when stdin is not a TTY", () => {
    const input = new FakeInput();
    input.isTTY = false;
    const proc = new FakeProcess();
    const abort = vi.fn();
    const dispose = installNoninteractiveCancellation({ input, proc, abort });

    proc.emit("SIGINT");
    proc.emit("SIGTERM");

    expect(abort).toHaveBeenCalledTimes(2);
    expect(input.rawModes).toEqual([]);
    dispose();
  });

  it("removes key and signal listeners on cleanup", () => {
    const input = new FakeInput();
    const proc = new FakeProcess();
    const abort = vi.fn();
    const dispose = installNoninteractiveCancellation({ input, proc, abort });

    dispose();
    dispose();
    input.emit("data", Buffer.from([0x1b]));
    proc.emit("SIGINT");

    expect(abort).not.toHaveBeenCalled();
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("preserves raw mode when the caller already owned it", () => {
    const input = new FakeInput();
    input.isRaw = true;
    const dispose = installNoninteractiveCancellation({
      input,
      proc: new FakeProcess(),
      abort: vi.fn(),
    });

    dispose();

    expect(input.rawModes).toEqual([]);
    expect(input.isRaw).toBe(true);
  });

  it("returns exit code 130 when a one-shot signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const input = new FakeInput();
    input.isTTY = false;
    const result = await startNoninteractive({
      prompt: "find pdfs",
      mode: "ask",
      noHistory: true,
      signal: controller.signal,
      input,
      out: new PassThrough(),
      err: new PassThrough(),
      color: false,
      unicode: false,
    });

    expect(result.outcome.status).toBe("aborted");
    expect(result.exitCode).toBe(130);
  });
});
