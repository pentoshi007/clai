import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeChildBridge } from "../../src/session-runtime/child-bridge.js";
import {
  ensureRuntimeDirectories,
  isRuntimeSocketPath,
  runtimeSocketPath,
} from "../../src/session-runtime/paths.js";
import {
  JsonFrameChannel,
  readFirstFrame,
  sendFrame,
} from "../../src/session-runtime/protocol.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeChildFrame,
  type RuntimeMetadata,
} from "../../src/session-runtime/types.js";
import {
  idleRuntimeCap,
  selectEvictableRuntimes,
} from "../../src/session-runtime/reaper.js";

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("switch frame fresh flag", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((dispose) => dispose()));
  });

  async function connectedBridge(): Promise<{
    bridge: RuntimeChildBridge;
    frames: RuntimeChildFrame[];
  }> {
    await ensureRuntimeDirectories();
    const path = runtimeSocketPath(`fresh-${Date.now()}-${Math.random()}`);
    if (process.platform !== "win32" && isRuntimeSocketPath(path)) {
      await rm(path, { force: true });
    }
    const frames: RuntimeChildFrame[] = [];
    const sockets = new Set<Socket>();
    const channels = new Set<JsonFrameChannel>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      void (async () => {
        const first = await readFirstFrame(socket);
        sendFrame(socket, {
          version: RUNTIME_PROTOCOL_VERSION,
          type: "ack",
          sessionId: "fresh-session",
        });
        const channel = new JsonFrameChannel(
          socket,
          (value) => frames.push(value as RuntimeChildFrame),
          () => socket.destroy(),
          first.rest,
        );
        channels.add(channel);
        socket.once("close", () => channels.delete(channel));
      })().catch(() => socket.destroy());
    });
    await listen(server, path);
    const bridge = new RuntimeChildBridge(path, "a".repeat(64));
    cleanup.push(async () => {
      bridge.dispose();
      for (const channel of channels) channel.dispose();
      for (const socket of sockets) socket.destroy();
      await close(server);
      if (process.platform !== "win32" && isRuntimeSocketPath(path)) {
        await rm(path, { force: true });
      }
    });
    expect(await bridge.connect()).toBe(true);
    return { bridge, frames };
  }

  it("carries fresh:true when a fresh fork is requested", async () => {
    const { bridge, frames } = await connectedBridge();
    bridge.switchSession("target-fresh", false, true);
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "switch")).toBe(true),
    );
    const switchFrame = frames.find(
      (frame): frame is Extract<RuntimeChildFrame, { type: "switch" }> =>
        frame.type === "switch",
    );
    expect(switchFrame).toMatchObject({
      type: "switch",
      sessionId: "target-fresh",
      closeCurrent: false,
      fresh: true,
    });
  });

  it("omits the fresh field for an ordinary switch (back-compat)", async () => {
    const { bridge, frames } = await connectedBridge();
    bridge.switchSession("target-plain", true);
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.type === "switch")).toBe(true),
    );
    const switchFrame = frames.find(
      (frame): frame is Extract<RuntimeChildFrame, { type: "switch" }> =>
        frame.type === "switch",
    );
    expect(switchFrame).toMatchObject({
      type: "switch",
      sessionId: "target-plain",
      closeCurrent: true,
    });
    expect(switchFrame && "fresh" in switchFrame).toBe(false);
  });
});

function runtime(
  overrides: Partial<RuntimeMetadata> & { sessionId: string; updatedAt: string },
): RuntimeMetadata {
  return {
    version: RUNTIME_PROTOCOL_VERSION,
    hostPid: 1234,
    socketPath: "/tmp/x.sock",
    token: "a".repeat(64),
    cwd: "/tmp",
    startedAt: overrides.updatedAt,
    phase: "running",
    busy: false,
    attached: false,
    ...overrides,
  };
}

describe("idle runtime LRU selection", () => {
  it("keeps everything when under the cap", () => {
    const runtimes = [
      runtime({ sessionId: "a", updatedAt: "2026-01-01T00:00:00.000Z" }),
      runtime({ sessionId: "b", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(selectEvictableRuntimes(runtimes, 2)).toEqual([]);
  });

  it("evicts the oldest idle detached runtimes beyond the cap", () => {
    const runtimes = [
      runtime({ sessionId: "old", updatedAt: "2026-01-01T00:00:00.000Z" }),
      runtime({ sessionId: "mid", updatedAt: "2026-01-02T00:00:00.000Z" }),
      runtime({ sessionId: "new", updatedAt: "2026-01-03T00:00:00.000Z" }),
    ];
    const victims = selectEvictableRuntimes(runtimes, 1).map((r) => r.sessionId);
    expect(victims).toEqual(["old", "mid"]);
  });

  it("never selects a busy or attached runtime", () => {
    const runtimes = [
      runtime({ sessionId: "busy", updatedAt: "2026-01-01T00:00:00.000Z", busy: true }),
      runtime({
        sessionId: "attached",
        updatedAt: "2026-01-01T00:00:01.000Z",
        attached: true,
      }),
      runtime({ sessionId: "idle", updatedAt: "2026-01-01T00:00:02.000Z" }),
    ];
    expect(selectEvictableRuntimes(runtimes, 0).map((r) => r.sessionId)).toEqual([
      "idle",
    ]);
  });

  it("excludes the freshly created runtime from eviction", () => {
    const runtimes = [
      runtime({ sessionId: "keep", updatedAt: "2026-01-01T00:00:00.000Z" }),
      runtime({ sessionId: "self", updatedAt: "2026-01-01T00:00:01.000Z" }),
    ];
    expect(
      selectEvictableRuntimes(runtimes, 0, "self").map((r) => r.sessionId),
    ).toEqual(["keep"]);
  });

  it("counts the excluded runtime toward the idle cap", () => {
    const runtimes = Array.from({ length: 7 }, (_, index) =>
      runtime({
        sessionId: index === 6 ? "self" : `idle-${index}`,
        updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
      }),
    );
    expect(
      selectEvictableRuntimes(runtimes, 6, "self").map((r) => r.sessionId),
    ).toEqual(["idle-0"]);
  });

  it("evicts nothing when the cap is disabled", () => {
    const runtimes = [
      runtime({ sessionId: "a", updatedAt: "2026-01-01T00:00:00.000Z" }),
      runtime({ sessionId: "b", updatedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(selectEvictableRuntimes(runtimes, Number.POSITIVE_INFINITY)).toEqual([]);
  });
});

describe("idleRuntimeCap", () => {
  const original = process.env.CLAI_SESSION_RUNTIME_MAX_IDLE;
  afterEach(() => {
    if (original === undefined) delete process.env.CLAI_SESSION_RUNTIME_MAX_IDLE;
    else process.env.CLAI_SESSION_RUNTIME_MAX_IDLE = original;
  });

  it("uses the default when unset", () => {
    delete process.env.CLAI_SESSION_RUNTIME_MAX_IDLE;
    expect(idleRuntimeCap()).toBe(6);
  });

  it("honors a configured positive value within bounds", () => {
    process.env.CLAI_SESSION_RUNTIME_MAX_IDLE = "3";
    expect(idleRuntimeCap()).toBe(3);
  });

  it("treats zero or negative as disabled", () => {
    process.env.CLAI_SESSION_RUNTIME_MAX_IDLE = "0";
    expect(idleRuntimeCap()).toBe(Number.POSITIVE_INFINITY);
  });

  it("uses the default for a malformed value", () => {
    process.env.CLAI_SESSION_RUNTIME_MAX_IDLE = "not-a-number";
    expect(idleRuntimeCap()).toBe(6);
  });
});
