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
  if (
    frame.type === "repaint" &&
    typeof frame.requestId === "string" &&
    frame.requestId.length > 0 &&
    frame.requestId.length <= 128
  ) {
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
  private repaint: (() => boolean) | undefined;
  private readonly pendingRepaints = new Set<string>();
  private disposed = false;
  private connecting: Promise<boolean> | undefined;

  constructor(
    private readonly socketPath: string,
    private readonly token: string,
    private readonly supportsRepaint = false,
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

  setRepaintHandler(handler: (() => boolean) | undefined): void {
    this.repaint = handler;
    if (!handler || this.disposed || this.pendingRepaints.size === 0) return;
    const pending = [...this.pendingRepaints];
    this.pendingRepaints.clear();
    for (const requestId of pending) this.answerRepaint(requestId);
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

  switchSession(sessionId: string, closeCurrent: boolean, fresh = false): boolean {
    return this.send({
      type: "switch",
      sessionId,
      closeCurrent,
      ...(fresh ? { fresh: true } : {}),
    });
  }

  dispose(exitCode = 0): void {
    if (this.disposed) return;
    this.send({ type: "exiting", exitCode });
    this.disposed = true;
    this.repaint = undefined;
    this.pendingRepaints.clear();
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
        ...(this.supportsRepaint ? { supportsRepaint: true } : {}),
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
    if (frame?.type === "shutdown") {
      this.shutdown?.();
      return;
    }
    if (frame?.type !== "repaint" || this.disposed) return;
    if (!this.repaint) {
      if (this.pendingRepaints.size >= 8) {
        const oldest = this.pendingRepaints.values().next().value;
        if (oldest) this.pendingRepaints.delete(oldest);
      }
      this.pendingRepaints.add(frame.requestId);
      return;
    }
    this.answerRepaint(frame.requestId);
  }

  private answerRepaint(requestId: string): void {
    let accepted = false;
    try {
      accepted = this.repaint?.() === true;
    } catch {
      accepted = false;
    }
    this.send({
      type: "repaint-result",
      requestId,
      accepted,
    });
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
    this.pendingRepaints.clear();
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

export function createRuntimeChildBridge(
  supportsRepaint = false,
): RuntimeChildBridge | undefined {
  if (process.env[RUNTIME_CHILD_ENV] !== "1") return undefined;
  const socketPath = process.env[RUNTIME_SOCKET_ENV]?.trim();
  const token = process.env[RUNTIME_TOKEN_ENV]?.trim();
  if (!socketPath || !token || !/^[a-f0-9]{64}$/i.test(token)) return undefined;
  return new RuntimeChildBridge(socketPath, token, supportsRepaint);
}
