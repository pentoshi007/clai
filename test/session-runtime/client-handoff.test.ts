import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_MODE_RESET } from "../../src/os/screen-sequences.js";
import {
  RUNTIME_CHILD_ENV,
  RUNTIME_DISABLE_ENV,
  RUNTIME_HOST_ENV,
} from "../../src/session-runtime/launch.js";
import type { RuntimeMetadata } from "../../src/session-runtime/types.js";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  readFirstFrame: vi.fn(),
  findLiveRuntime: vi.fn(),
  probePtyCapability: vi.fn(),
}));

vi.mock("../../src/session-runtime/protocol.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/session-runtime/protocol.js")>()),
  connectRuntimeSocket: mocks.connect,
  readFirstFrame: mocks.readFirstFrame,
}));

vi.mock("../../src/session-runtime/discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/session-runtime/discovery.js")>()),
  findLiveRuntime: mocks.findLiveRuntime,
}));

vi.mock("../../src/interactive-session/transport-node-pty.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/interactive-session/transport-node-pty.js")>()),
  probePtyCapability: mocks.probePtyCapability,
}));

vi.mock("../../src/store/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/store/config.js")>()),
  getConfig: () => ({ privateMode: false }),
}));

import { tryRunDurableInteractive } from "../../src/session-runtime/client.js";

class Input extends PassThrough {
  readonly isTTY = true;
  isRaw = false;
  readonly rawChanges: boolean[] = [];

  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    this.rawChanges.push(raw);
    return this;
  }
}

class Socket extends EventEmitter {
  writable = true;
  destroyed = false;
  readableEnded = false;
  paused = true;
  backpressured = false;
  rest = Buffer.alloc(0);
  readonly writes: Array<string | Buffer> = [];

  write(bytes: string | Buffer): boolean {
    this.writes.push(bytes);
    return !this.backpressured;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  resume(): this {
    this.paused = false;
    return this;
  }

  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    this.emit("close");
    return this;
  }

  frame(value: unknown): void {
    this.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }
}

class Output extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 100;
  readonly rows = 30;
  readonly writableNeedDrain = false;
  holdResets = false;
  throwOnReplay = false;
  readonly writes: string[] = [];
  readonly pendingResets: Array<(error?: Error | null) => void> = [];

  write(bytes: string | Buffer, callback?: (error?: Error | null) => void): boolean {
    if (this.throwOnReplay && Buffer.isBuffer(bytes)) throw new Error("replay failed");
    const text = bytes.toString();
    this.writes.push(text);
    if (callback) {
      if (this.holdResets && text.startsWith(TERMINAL_MODE_RESET)) {
        this.pendingResets.push(callback);
      } else {
        callback();
      }
    }
    return true;
  }
}

function metadata(sessionId: string): RuntimeMetadata {
  return {
    version: 1,
    sessionId,
    hostPid: 1234,
    socketPath: `/tmp/${sessionId}.sock`,
    token: "a".repeat(64),
    cwd: "/tmp",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    phase: "running",
    busy: false,
    attached: false,
  };
}

describe("durable client terminal handoff", () => {
  let input: Input;
  let output: Output;
  let control: Socket;
  let terminal: Socket;
  let previousExitCode: typeof process.exitCode;

  beforeEach(() => {
    vi.resetAllMocks();
    for (const key of [RUNTIME_CHILD_ENV, RUNTIME_DISABLE_ENV, RUNTIME_HOST_ENV]) {
      vi.stubEnv(key, undefined);
    }
    input = new Input();
    output = new Output();
    control = new Socket();
    terminal = new Socket();
    previousExitCode = process.exitCode;
    vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as NodeJS.ReadStream);
    vi.spyOn(process, "stdout", "get").mockReturnValue(output as unknown as NodeJS.WriteStream);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    mocks.probePtyCapability.mockResolvedValue({ available: true, platform: process.platform });
    mocks.findLiveRuntime.mockImplementation(async (id: string) => metadata(id));
    mocks.connect.mockResolvedValueOnce(control).mockResolvedValueOnce(terminal);
    mocks.readFirstFrame.mockImplementation(async (socket: Socket) => ({
      value: { version: 1, type: "ack", sessionId: "first" },
      rest: socket.rest,
    }));
  });

  afterEach(() => {
    input.destroy();
    process.exitCode = previousExitCode;
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function run(): Promise<boolean> {
    return tryRunDurableInteractive({
      entryPath: "/tmp/clai-entry.js",
      childArgs: [],
      resume: { kind: "id", id: "first" },
    });
  }

  async function attached(socket = terminal): Promise<void> {
    await vi.waitFor(() => expect(socket.listenerCount("data")).toBe(1));
  }

  function detach(socket = control): void {
    socket.frame({ type: "detached", sessionId: "first", reason: "requested" });
  }

  it.each(["detach", "exit"])("flushes terminal reset before restoring raw mode on %s", async (outcome) => {
    output.holdResets = true;
    const running = run();
    await attached();
    terminal.emit("data", Buffer.from("\u001b[?1049h\u001b[?1000h"));
    if (outcome === "exit") {
      terminal.readableEnded = true;
      control.frame({ type: "exit", exitCode: 0 });
    } else {
      detach();
    }
    await vi.waitFor(() => expect(output.pendingResets).toHaveLength(1));
    expect(input.rawChanges).toEqual([true]);
    expect(input.isPaused()).toBe(false);
    expect(output.writes.at(-1)).toBe(`${TERMINAL_MODE_RESET}\u001b[?1049l`);
    input.write("\u001b[<64;12;9M");
    expect(input.readableLength).toBe(0);
    expect(terminal.writes.filter(Buffer.isBuffer)).toHaveLength(0);
    output.pendingResets.shift()!();
    expect(await running).toBe(true);
    expect(input.rawChanges).toEqual([true, false]);
    expect(input.isPaused()).toBe(true);
    expect(input.listenerCount("data")).toBe(0);
    expect(output.listenerCount("error")).toBe(0);
  });

  it("keeps raw mode and discards input throughout switch lookup and handshake", async () => {
    const nextControl = new Socket();
    const nextTerminal = new Socket();
    let resolveLookup!: (value: RuntimeMetadata) => void;
    let resolveConnection!: (value: Socket) => void;
    const lookup = new Promise<RuntimeMetadata>((resolve) => { resolveLookup = resolve; });
    const connection = new Promise<Socket>((resolve) => { resolveConnection = resolve; });
    mocks.connect.mockImplementationOnce(() => connection).mockResolvedValueOnce(nextTerminal);
    const running = run();
    await attached();
    terminal.backpressured = true;
    input.write("before");
    expect(input.isPaused()).toBe(true);
    mocks.findLiveRuntime.mockImplementationOnce(() => lookup);
    control.frame({ type: "switch", sessionId: "second", fresh: false });
    await vi.waitFor(() => expect(mocks.findLiveRuntime).toHaveBeenCalledWith("second"));
    expect(input.isPaused()).toBe(false);
    input.write("\u001b[<64;12;9M");
    expect(input.readableLength).toBe(0);
    expect(input.rawChanges).toEqual([true]);
    resolveLookup(metadata("second"));
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(3));
    input.write("\u001b[<65;12;9M");
    expect(input.readableLength).toBe(0);
    expect(input.rawChanges).toEqual([true]);
    resolveConnection(nextControl);
    await attached(nextTerminal);
    expect(nextTerminal.writes.filter(Buffer.isBuffer)).toHaveLength(0);
    input.write("after");
    expect(nextTerminal.writes.filter(Buffer.isBuffer).map(String)).toEqual(["after"]);
    detach(nextControl);
    expect(await running).toBe(true);
    expect(input.rawChanges).toEqual([true, false]);
  });

  it("restores an already raw terminal without turning echo on", async () => {
    input.isRaw = true;
    const running = run();
    await attached();
    detach();
    expect(await running).toBe(true);
    expect(input.rawChanges).toEqual([true, true]);
  });

  it("restores the terminal when termination arrives during a connection transition", async () => {
    let resolveConnection!: (socket: Socket) => void;
    const connection = new Promise<Socket>((resolve) => { resolveConnection = resolve; });
    mocks.connect.mockReset().mockImplementationOnce(() => connection).mockResolvedValueOnce(terminal);
    const running = run();
    await vi.waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));
    process.emit("SIGTERM");
    expect(input.rawChanges).toEqual([true]);
    input.write("\u001b[<64;12;9M");
    expect(input.readableLength).toBe(0);
    resolveConnection(control);
    expect(await running).toBe(true);
    expect(process.exitCode).toBe(143);
    expect(input.rawChanges).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    expect(terminal.destroyed).toBe(true);
  });

  it("cleans up sockets and raw mode when initial replay throws", async () => {
    terminal.rest = Buffer.from("\u001b[?1049h");
    output.throwOnReplay = true;
    expect(await run()).toBe(false);
    expect(control.destroyed).toBe(true);
    expect(terminal.destroyed).toBe(true);
    expect(input.rawChanges).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
    expect(terminal.listenerCount("data")).toBe(0);
    expect(output.writes).toContain(`${TERMINAL_MODE_RESET}\u001b[?1049l`);
  });

  it("closes both channels and restores raw mode when terminal authentication fails", async () => {
    mocks.readFirstFrame
      .mockResolvedValueOnce({ value: { version: 1, type: "ack", sessionId: "first" }, rest: Buffer.alloc(0) })
      .mockRejectedValueOnce(new Error("handshake failed"));
    expect(await run()).toBe(false);
    expect(control.destroyed).toBe(true);
    expect(terminal.destroyed).toBe(true);
    expect(input.rawChanges).toEqual([true, false]);
    expect(input.listenerCount("data")).toBe(0);
  });

  it.each(["error", "timeout"])("releases raw mode when reset completion ends with %s", async (failure) => {
    output.holdResets = true;
    const running = run();
    await attached();
    vi.useFakeTimers();
    detach();
    await vi.waitFor(() => expect(output.pendingResets).toHaveLength(1));
    expect(input.rawChanges).toEqual([true]);
    if (failure === "error") output.emit("error", new Error("terminal closed"));
    else await vi.advanceTimersByTimeAsync(1_000);
    expect(await running).toBe(true);
    expect(input.rawChanges).toEqual([true, false]);
    expect(output.listenerCount("error")).toBe(0);
    output.pendingResets.shift()!();
    expect(input.rawChanges).toEqual([true, false]);
  });
});
