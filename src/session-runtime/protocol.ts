import { connect, type Socket } from "node:net";

const MAX_FRAME_BYTES = 64 * 1024;

export interface FirstFrame {
  readonly value: unknown;
  readonly rest: Buffer<ArrayBufferLike>;
}

export function sendFrame(socket: Socket, value: unknown): boolean {
  if (!socket.writable || socket.destroyed) return false;
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded) > MAX_FRAME_BYTES) return false;
  socket.write(encoded);
  return true;
}

export function readFirstFrame(
  socket: Socket,
  timeoutMs = 2_000,
): Promise<FirstFrame> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("runtime handshake timed out")), timeoutMs);
    timer.unref?.();

    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (error?: Error, frame?: FirstFrame): void => {
      cleanup();
      if (error) reject(error);
      else if (frame) resolve(frame);
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error("runtime channel closed during handshake"));
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        if (buffer.length > MAX_FRAME_BYTES) {
          finish(new Error("runtime handshake exceeded its size limit"));
        }
        return;
      }
      if (newline + 1 > MAX_FRAME_BYTES) {
        finish(new Error("runtime handshake exceeded its size limit"));
        return;
      }
      const line = buffer.subarray(0, newline).toString("utf8").trim();
      const rest = buffer.subarray(newline + 1);
      try {
        const value = JSON.parse(line) as unknown;
        socket.pause();
        finish(undefined, { value, rest });
      } catch {
        finish(new Error("runtime handshake was not valid JSON"));
      }
    };

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export class JsonFrameChannel {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  private disposed = false;

  constructor(
    private readonly socket: Socket,
    private readonly onFrame: (value: unknown) => void,
    private readonly onFailure: (error: Error) => void,
    initial: Buffer<ArrayBufferLike> = Buffer.alloc(0),
  ) {
    this.buffer = initial;
    socket.on("data", this.handleData);
    socket.on("error", this.handleError);
    this.drain();
    socket.resume();
  }

  send(value: unknown): boolean {
    return sendFrame(this.socket, value);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.socket.off("data", this.handleData);
    this.socket.off("error", this.handleError);
  }

  private readonly handleData = (chunk: Buffer): void => {
    if (this.disposed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.drain();
    if (!this.disposed && this.buffer.length > MAX_FRAME_BYTES) {
      this.fail(new Error("runtime control frame exceeded its size limit"));
    }
  };

  private readonly handleError = (error: Error): void => this.fail(error);

  private drain(): void {
    while (!this.disposed) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      if (newline + 1 > MAX_FRAME_BYTES) {
        this.fail(new Error("runtime control frame exceeded its size limit"));
        return;
      }
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (!line) continue;
      try {
        this.onFrame(JSON.parse(line) as unknown);
      } catch {
        this.fail(new Error("runtime control frame was not valid JSON"));
      }
    }
  }

  private fail(error: Error): void {
    if (this.disposed) return;
    this.dispose();
    this.onFailure(error);
  }
}

export function connectRuntimeSocket(path: string, timeoutMs = 2_000): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("runtime socket connection timed out"));
    }, timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("error", onError);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.once("error", onError);
    socket.once("connect", () => {
      cleanup();
      socket.setNoDelay(true);
      resolve(socket);
    });
  });
}
