import { describe, expect, it } from "vitest";
import {
  RendererLifecycle,
  type ProcessLike,
} from "../../src/ui-core/bootstrap/lifecycle.js";
import { createClassicRenderer } from "../../src/classic/bootstrap/renderer-handle.js";
import {
  BRACKETED_PASTE_OFF,
  BRACKETED_PASTE_ON,
  CURSOR_HIDE,
  CURSOR_SHOW,
  createTerminalSession,
} from "../../src/classic/bootstrap/terminal-session.js";

type Listener = (...args: unknown[]) => void;

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function harness(options: { failStart?: boolean } = {}) {
  const writes: string[] = [];
  const stdout = {
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };

  const dataListeners = new Set<(chunk: string | Buffer) => void>();
  const rawModeCalls: boolean[] = [];
  const stdin = {
    isTTY: true,
    setRawMode(mode: boolean) {
      rawModeCalls.push(mode);
    },
    setEncoding() {},
    resume() {},
    pause() {},
    on(_event: "data", listener: (chunk: string | Buffer) => void) {
      dataListeners.add(listener);
    },
    off(_event: "data", listener: (chunk: string | Buffer) => void) {
      dataListeners.delete(listener);
    },
  };

  const session = createTerminalSession({ stdout, stdin, mouse: false });

  const counts = { mount: 0, unmount: 0, dispose: 0 };
  const control = {
    mount() {
      if (options.failStart) throw new Error("mount failed");
      counts.mount += 1;
    },
    unmount() {
      counts.unmount += 1;
    },
  };

  const received: string[] = [];
  const { handle, done } = createClassicRenderer({
    session,
    control,
    onData: (chunk) => received.push(chunk),
    disposeServices: () => {
      counts.dispose += 1;
    },
  });

  const listeners = new Map<string, Listener[]>();
  const exitCodes: Array<number | undefined> = [];
  const proc: ProcessLike = {
    on(event: string, listener: Listener) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener);
      listeners.set(event, bucket);
      return proc;
    },
    off(event: string, listener: Listener) {
      const bucket = (listeners.get(event) ?? []).filter((fn) => fn !== listener);
      listeners.set(event, bucket);
      return proc;
    },
    exit(code?: number) {
      exitCodes.push(code);
    },
  };

  const disposed: string[] = [];
  let sigints = 0;
  const lifecycle = new RendererLifecycle({
    handle,
    process: proc,
    disposers: [
      () => disposed.push("persist"),
      () => disposed.push("restore-console"),
      () => disposed.push("close-sessions"),
    ],
    onSigint: () => {
      sigints += 1;
    },
  });

  return {
    lifecycle,
    session,
    done,
    writes,
    counts,
    disposed,
    exitCodes,
    received,
    rawModeCalls,
    dataListeners,
    get sigints() {
      return sigints;
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(...args);
    },
    countOf(sequence: string) {
      return writes.filter((chunk) => chunk === sequence).length;
    },
  };
}

async function expectCleanTeardown(h: ReturnType<typeof harness>): Promise<void> {
  await h.done;
  expect(h.countOf(CURSOR_SHOW)).toBe(1);
  expect(h.countOf(BRACKETED_PASTE_OFF)).toBe(1);
  expect(h.counts.unmount).toBe(1);
  expect(h.counts.dispose).toBe(1);
  expect(h.disposed).toEqual(["close-sessions", "restore-console", "persist"]);
  expect(h.session.entered).toBe(false);
  expect(h.session.inputAttached).toBe(false);
  expect(h.dataListeners.size).toBe(0);
}

describe("classic renderer lifecycle", () => {
  it("enters the terminal, attaches input, and mounts on start", async () => {
    const h = harness();
    await h.lifecycle.start();
    expect(h.writes).toEqual(["\x1b[?1049h", "\x1b[2J", "\x1b[H", BRACKETED_PASTE_ON, CURSOR_HIDE]);
    expect(h.rawModeCalls).toEqual([true]);
    expect(h.counts.mount).toBe(1);
    await h.lifecycle.shutdownAndExit(0);
    await expectCleanTeardown(h);
  });

  it("restores the terminal exactly once on a normal exit", async () => {
    const h = harness();
    await h.lifecycle.start();
    await h.lifecycle.shutdownAndExit(0);
    await h.lifecycle.shutdownAndExit(0);
    expect(h.exitCodes).toEqual([0, 0]);
    await expectCleanTeardown(h);
  });

  it("treats the first SIGINT as cooperative and the second as exit 130", async () => {
    const h = harness();
    await h.lifecycle.start();
    h.emit("SIGINT");
    await flush();
    expect(h.sigints).toBe(1);
    expect(h.exitCodes).toEqual([]);
    expect(h.session.entered).toBe(true);
    h.emit("SIGINT");
    await flush();
    expect(h.exitCodes).toEqual([130]);
    await expectCleanTeardown(h);
  });

  it("exits 143 on SIGTERM", async () => {
    const h = harness();
    await h.lifecycle.start();
    h.emit("SIGTERM");
    await flush();
    expect(h.exitCodes).toEqual([143]);
    await expectCleanTeardown(h);
  });

  it("exits 129 on SIGHUP", async () => {
    const h = harness();
    await h.lifecycle.start();
    h.emit("SIGHUP");
    await flush();
    expect(h.exitCodes).toEqual([129]);
    await expectCleanTeardown(h);
  });

  it("exits 1 on an uncaught exception", async () => {
    const h = harness();
    await h.lifecycle.start();
    h.emit("uncaughtException", new Error("boom"));
    await flush();
    expect(h.exitCodes).toEqual([1]);
    await expectCleanTeardown(h);
  });

  it("exits 1 on an unhandled rejection", async () => {
    const h = harness();
    await h.lifecycle.start();
    h.emit("unhandledRejection", new Error("boom"));
    await flush();
    expect(h.exitCodes).toEqual([1]);
    await expectCleanTeardown(h);
  });

  it("restores the terminal when the mount fails", async () => {
    const h = harness({ failStart: true });
    await expect(h.lifecycle.start()).rejects.toThrow("mount failed");
    expect(h.counts.mount).toBe(0);
    await expectCleanTeardown(h);
  });

  it("routes decoded bytes to the input handler while attached", async () => {
    const h = harness();
    await h.lifecycle.start();
    for (const listener of h.dataListeners) listener("\x03");
    expect(h.received).toEqual(["\x03"]);
    await h.lifecycle.shutdownAndExit(0);
    await expectCleanTeardown(h);
  });
});
