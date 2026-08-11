import { describe, expect, it, vi } from "vitest";
import {
  RendererLifecycle,
  type ProcessLike,
  type RendererHandle,
} from "../../src/ui-core/bootstrap/lifecycle.js";

/**
 * Signal handlers fire shutdown fire-and-forget (`void shutdownAndExit`), so
 * the test cannot await their promise. Flush microtasks until a condition
 * holds (bounded) instead of counting a fixed number of ticks — teardown depth
 * is an implementation detail that must not make these assertions fragile.
 */
async function flushUntil(
  predicate: () => boolean,
  maxTicks = 50,
): Promise<void> {
  for (let i = 0; i < maxTicks && !predicate(); i += 1) {
    await Promise.resolve();
  }
}

class FakeProcess implements ProcessLike {
  readonly handlers = new Map<string, Set<(...a: unknown[]) => void>>();
  readonly exitCalls: number[] = [];

  on(event: string, listener: (...a: unknown[]) => void): unknown {
    const set = this.handlers.get(event) ?? new Set();
    set.add(listener);
    this.handlers.set(event, set);
    return this;
  }
  off(event: string, listener: (...a: unknown[]) => void): unknown {
    this.handlers.get(event)?.delete(listener);
    return this;
  }
  exit(code = 0): void {
    this.exitCalls.push(code);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
  }
  listenerCount(): number {
    let total = 0;
    for (const set of this.handlers.values()) total += set.size;
    return total;
  }
}

function makeHandle(log: string[]): RendererHandle {
  return {
    start: () => {
      log.push("start");
    },
    destroy: () => {
      log.push("destroy");
    },
  };
}

describe("RendererLifecycle teardown", () => {
  it("disposes extra resources in reverse creation order before destroy", async () => {
    const log: string[] = [];
    const proc = new FakeProcess();
    const life = new RendererLifecycle({
      handle: makeHandle(log),
      process: proc,
      disposers: [
        () => void log.push("dispose-a"),
        () => void log.push("dispose-b"),
      ],
    });
    await life.start();
    await life.shutdown();
    expect(log).toEqual(["start", "dispose-b", "dispose-a", "destroy"]);
  });

  it("is idempotent: destroy runs exactly once across repeated shutdowns", async () => {
    const log: string[] = [];
    const proc = new FakeProcess();
    const life = new RendererLifecycle({ handle: makeHandle(log), process: proc });
    await life.start();
    await life.shutdown();
    await life.shutdown();
    expect(log.filter((l) => l === "destroy")).toHaveLength(1);
    expect(life.isDestroyed).toBe(true);
  });

  it("destroys the renderer before exiting", async () => {
    const order: string[] = [];
    const proc = new FakeProcess();
    proc.exit = (code = 0) => {
      order.push(`exit:${code}`);
    };
    const handle: RendererHandle = {
      start: () => {},
      destroy: () => void order.push("destroy"),
    };
    const life = new RendererLifecycle({ handle, process: proc });
    await life.start();
    await life.shutdownAndExit(0);
    expect(order).toEqual(["destroy", "exit:0"]);
  });
});

describe("RendererLifecycle signal handling", () => {
  it("first SIGINT is cooperative (onSigint), second SIGINT exits", async () => {
    const log: string[] = [];
    const onSigint = vi.fn();
    const proc = new FakeProcess();
    const life = new RendererLifecycle({
      handle: makeHandle(log),
      process: proc,
      onSigint,
    });
    await life.start();
    proc.emit("SIGINT");
    await Promise.resolve();
    expect(onSigint).toHaveBeenCalledTimes(1);
    expect(proc.exitCalls).toEqual([]);
    expect(log).not.toContain("destroy");

    proc.emit("SIGINT");
    await flushUntil(() => proc.exitCalls.length > 0);
    expect(log).toContain("destroy");
    expect(proc.exitCalls).toContain(130);
  });

  it("removes all installed listeners on shutdown", async () => {
    const proc = new FakeProcess();
    const life = new RendererLifecycle({
      handle: makeHandle([]),
      process: proc,
    });
    await life.start();
    expect(proc.listenerCount()).toBeGreaterThan(0);
    await life.shutdown();
    expect(proc.listenerCount()).toBe(0);
  });

  it("routes uncaught exceptions through onError then exits non-zero", async () => {
    const onError = vi.fn();
    const proc = new FakeProcess();
    const life = new RendererLifecycle({
      handle: makeHandle([]),
      process: proc,
      onError,
    });
    await life.start();
    const boom = new Error("boom");
    proc.emit("uncaughtException", boom);
    await flushUntil(() => proc.exitCalls.length > 0);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(proc.exitCalls).toContain(1);
  });
});

describe("RendererLifecycle concurrent quit", () => {
  it("does not exit until an in-flight shutdown flush completes, even when a second exit races it", async () => {
    const log: string[] = [];
    const proc = new FakeProcess();
    let resolveFlush!: () => void;
    const flushGate = new Promise<void>((resolve) => {
      resolveFlush = resolve;
    });
    let flushDone = false;
    const life = new RendererLifecycle({
      handle: makeHandle(log),
      process: proc,
      // Models the awaited history persist in start-tui-v2's disposer.
      disposers: [
        async () => {
          await flushGate;
          flushDone = true;
          log.push("flushed");
        },
      ],
    });
    await life.start();

    // App Ctrl+C path and a racing SIGINT-driven exit both fire.
    const first = life.shutdownAndExit(0);
    const second = life.shutdownAndExit(130);

    // Neither may exit while the flush is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(proc.exitCalls).toEqual([]);
    expect(flushDone).toBe(false);

    resolveFlush();
    await Promise.all([first, second]);

    // Flush completed before any exit; disposer + destroy ran exactly once.
    expect(flushDone).toBe(true);
    expect(log.filter((l) => l === "flushed")).toHaveLength(1);
    expect(log.filter((l) => l === "destroy")).toHaveLength(1);
    expect(proc.exitCalls.length).toBeGreaterThanOrEqual(1);
    expect(proc.exitCalls).toContain(0);
  });
});

describe("RendererLifecycle start failure", () => {
  it("tears down and rethrows when the renderer fails to start", async () => {
    const proc = new FakeProcess();
    let destroyed = false;
    const handle: RendererHandle = {
      start: () => {
        throw new Error("no tty");
      },
      destroy: () => {
        destroyed = true;
      },
    };
    const life = new RendererLifecycle({ handle, process: proc });
    await expect(life.start()).rejects.toThrow("no tty");
    expect(destroyed).toBe(true);
  });
});
