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
import { RUNTIME_PROTOCOL_VERSION, type RuntimeChildFrame } from "../../src/session-runtime/types.js";

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("runtime child bridge", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((dispose) => dispose()));
  });

  it("deduplicates status while connected and resends the latest status once after reconnect", async () => {
    await ensureRuntimeDirectories();
    const path = runtimeSocketPath(`bridge-${Date.now()}`);
    if (process.platform !== "win32" && isRuntimeSocketPath(path)) {
      await rm(path, { force: true });
    }
    const statuses: Array<Extract<RuntimeChildFrame, { type: "status" }>> = [];
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
          sessionId: "bridge-session",
        });
        const channel = new JsonFrameChannel(
          socket,
          (value) => {
            const frame = value as RuntimeChildFrame;
            if (frame.type === "status") statuses.push(frame);
          },
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
    const initial = {
      sessionId: "bridge-session",
      cwd: process.cwd(),
      busy: true,
    } as const;
    bridge.report(initial);
    bridge.report(initial);
    await vi.waitFor(() => expect(statuses).toHaveLength(1));

    bridge.report({ ...initial, title: `  ${"t".repeat(400)}  ` });
    bridge.report({ ...initial, title: `  ${"t".repeat(400)}  ` });
    await vi.waitFor(() => expect(statuses).toHaveLength(2));
    expect(statuses[1]?.title).toHaveLength(256);

    const active = [...sockets][0];
    expect(active).toBeDefined();
    active?.destroy();
    await vi.waitFor(() => expect(statuses).toHaveLength(3), { timeout: 2_000 });
    expect(statuses[2]).toEqual(statuses[1]);
  });
});

describe("runtime child repaint bridge", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanup.splice(0).map((dispose) => dispose()));
  });

  it("advertises repaint support, preserves an early request, and handles reconnects", async () => {
    await ensureRuntimeDirectories();
    const path = runtimeSocketPath(`bridge-repaint-${Date.now()}`);
    if (process.platform !== "win32" && isRuntimeSocketPath(path)) {
      await rm(path, { force: true });
    }
    const authFrames: unknown[] = [];
    const repaintResults: Array<
      Extract<RuntimeChildFrame, { type: "repaint-result" }>
    > = [];
    const sockets = new Set<Socket>();
    const channels = new Set<JsonFrameChannel>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      void (async () => {
        const first = await readFirstFrame(socket);
        authFrames.push(first.value);
        sendFrame(socket, {
          version: RUNTIME_PROTOCOL_VERSION,
          type: "ack",
          sessionId: "bridge-repaint-session",
        });
        const channel = new JsonFrameChannel(
          socket,
          (value) => {
            const frame = value as RuntimeChildFrame;
            if (frame.type === "repaint-result") repaintResults.push(frame);
          },
          () => socket.destroy(),
          first.rest,
        );
        channels.add(channel);
        socket.once("close", () => channels.delete(channel));
        channel.send({
          type: "repaint",
          requestId: `connect-${String(authFrames.length)}`,
        });
      })().catch(() => socket.destroy());
    });
    await listen(server, path);

    const bridge = new RuntimeChildBridge(path, "b".repeat(64), true);
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
    await vi.waitFor(() => expect(authFrames).toHaveLength(1));
    expect(authFrames[0]).toMatchObject({ supportsRepaint: true });

    const repaint = vi.fn(() => true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    bridge.setRepaintHandler(repaint);
    await vi.waitFor(() => expect(repaint).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(repaintResults).toContainEqual({
        type: "repaint-result",
        requestId: "connect-1",
        accepted: true,
      }),
    );

    [...channels].at(-1)?.send({
      type: "repaint",
      requestId: "live-request",
    });
    await vi.waitFor(() => expect(repaint).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(repaintResults).toContainEqual({
        type: "repaint-result",
        requestId: "live-request",
        accepted: true,
      }),
    );

    repaint.mockReturnValueOnce(false);
    [...channels].at(-1)?.send({
      type: "repaint",
      requestId: "declined-request",
    });
    await vi.waitFor(() => expect(repaint).toHaveBeenCalledTimes(3));
    await vi.waitFor(() =>
      expect(repaintResults).toContainEqual({
        type: "repaint-result",
        requestId: "declined-request",
        accepted: false,
      }),
    );

    [...sockets].at(-1)?.destroy();
    await vi.waitFor(() => expect(authFrames).toHaveLength(2), {
      timeout: 2_500,
    });
    await vi.waitFor(() => expect(repaint).toHaveBeenCalledTimes(4), {
      timeout: 2_500,
    });

    bridge.dispose();
    const count = repaint.mock.calls.length;
    [...channels].at(-1)?.send({
      type: "repaint",
      requestId: "after-dispose",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(repaint).toHaveBeenCalledTimes(count);
  });
});