import type { Socket } from "node:net";
import {
  RUNTIME_CHILD_ENV,
  RUNTIME_SOCKET_ENV,
  RUNTIME_TOKEN_ENV,
} from "./launch.js";
import {
  JsonFrameChannel,
  connectRuntimeSocket,
  readFirstFrame,
  sendFrame,
} from "./protocol.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeAckFrame,
  type RuntimeChildFrame,
  type RuntimeHostFrame,
} from "./types.js";

function isAck(value: unknown): value is RuntimeAckFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<RuntimeAckFrame>;
  return (
    frame.version === RUNTIME_PROTOCOL_VERSION &&
    frame.type === "ack" &&
    typeof frame.sessionId === "string"
  );
}

function hostFrame(value: unknown): RuntimeHostFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Partial<RuntimeHostFrame>;
  if (frame.type === "shutdown" || frame.type === "pong") {
    return frame as RuntimeHostFrame;
  }
  return undefined;
}

export interface RuntimeChildStatus {
  readonly sessionId: string;
  readonly cwd: string;
  readonly busy: boolean;
  readonly title?: string | undefined;
}

export class RuntimeChildBridge {
  private socket: Socket | undefined;
  private channel: JsonFrameChannel | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private latestStatus: RuntimeChildStatus | undefined;
  private lastSentStatusKey: string | undefined;
  private shutdown: (() => void) | undefined;
  private disposed = false;
  private connecting: Promise<boolean> | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
  ) {}

  async connect(): Promise<boolean> {
    if (this.disposed) return false;
    if (this.channel && this.socket && !this.socket.destroyed) return true;
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return await this.connecting;
  }

  setShutdownHandler(handler: () => void): void {
    this.shutdown = handler;
  }

  report(status: RuntimeChildStatus): void {
    const title = status.title?.trim().slice(0, 256) || undefined;
    const normalized: RuntimeChildStatus = {
      sessionId: status.sessionId.trim().slice(0, 256),
      cwd: status.cwd.slice(0, 4096),
      busy: status.busy,
      ...(title ? { title } : {}),
    };
    const key = JSON.stringify([
      normalized.sessionId,
      normalized.cwd,
      normalized.busy,
      normalized.title ?? null,
    ]);
    this.latestStatus = normalized;
    if (
      key === this.lastSentStatusKey &&
      this.channel &&
      this.socket &&
      !this.socket.destroyed
    ) {
      return;
    }
    if (
      this.send({
        type: "status",
        sessionId: normalized.sessionId,
        cwd: normalized.cwd,
        busy: normalized.busy,
        ...(normalized.title ? { title: normalized.title } : {}),
      })
    ) {
      this.lastSentStatusKey = key;
      return;
    }
    this.scheduleReconnect();
  }

  minimise(): boolean {
    return this.send({ type: "minimise" });
  }

  switchSession(sessionId: string, closeCurrent: boolean): boolean {
    return this.send({ type: "switch", sessionId, closeCurrent });
  }

  dispose(exitCode = 0): void {
    if (this.disposed) return;
    this.send({ type: "exiting", exitCode });
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.channel?.dispose();
    this.socket?.destroy();
    this.channel = undefined;
    this.socket = undefined;
    this.lastSentStatusKey = undefined;
  }

  private async open(): Promise<boolean> {
    let socket: Socket | undefined;
    try {
      socket = await connectRuntimeSocket(this.socketPath);
      sendFrame(socket, {
        version: RUNTIME_PROTOCOL_VERSION,
        type: "auth",
        role: "child",
        token: this.token,
      });
      const first = await readFirstFrame(socket);
      if (!isAck(first.value)) throw new Error("runtime host rejected child channel");
      if (this.disposed) {
        socket.destroy();
        return false;
      }
      const connected = socket;
      this.socket = connected;
      this.channel = new JsonFrameChannel(
        connected,
        (value) => this.receive(value),
        () => connected.destroy(),
        first.rest,
      );
      connected.once("close", () => this.closed(connected));
      this.lastSentStatusKey = undefined;
      if (this.latestStatus) this.report(this.latestStatus);
      return true;
    } catch {
      socket?.destroy();
      this.scheduleReconnect();
      return false;
    }
  }

  private receive(value: unknown): void {
    const frame = hostFrame(value);
    if (frame?.type === "shutdown") this.shutdown?.();
  }

  private send(frame: RuntimeChildFrame): boolean {
    return this.channel?.send(frame) ?? false;
  }

  private closed(socket: Socket): void {
    if (this.socket !== socket) return;
    this.channel?.dispose();
    this.channel = undefined;
    this.socket = undefined;
    this.lastSentStatusKey = undefined;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, 500);
    this.reconnectTimer.unref?.();
  }
}

export function createRuntimeChildBridge(): RuntimeChildBridge | undefined {
  if (process.env[RUNTIME_CHILD_ENV] !== "1") return undefined;
  const socketPath = process.env[RUNTIME_SOCKET_ENV]?.trim();
  const token = process.env[RUNTIME_TOKEN_ENV]?.trim();
  if (!socketPath || !token || !/^[a-f0-9]{64}$/i.test(token)) return undefined;
  return new RuntimeChildBridge(socketPath, token);
}
