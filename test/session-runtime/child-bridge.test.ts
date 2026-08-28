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
