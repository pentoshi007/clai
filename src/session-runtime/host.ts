import { randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { processIdentityTracker } from "../os/process-identity.js";
import { processAlive } from "../os/process-tree.js";
import { startPtyProcess } from "../interactive-session/transport-node-pty.js";
import type {
  ProcessOutcome,
  TerminalDimensions,
} from "../interactive-session/types.js";
import type { SessionTransport } from "../interactive-session/transport.js";
import {
  RUNTIME_CHILD_ENV,
  RUNTIME_HOST_ENV,
  RUNTIME_SESSION_ENV,
  RUNTIME_SOCKET_ENV,
  RUNTIME_TOKEN_ENV,
  decodeRuntimeHostPayload,
} from "./launch.js";
import { isRuntimeSocketPath, runtimeSocketPath } from "./paths.js";
import {
  JsonFrameChannel,
  readFirstFrame,
  sendFrame,
} from "./protocol.js";
import { TerminalReplayBuffer } from "./replay-buffer.js";
import { TerminalAttachOutput } from "./attach-output.js";
import { TerminalModeState } from "./terminal-modes.js";
import { enforceIdleRuntimeCap } from "./reaper.js";
import {
  createRuntimeToken,
  deleteRuntimeMetadata,
  reapStaleRuntimeLock,
  tryAcquireRuntimeLease,
  writeRuntimeMetadata,
  type RuntimeLease,
} from "./store.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeAuthFrame,
  type RuntimeChildFrame,
  type RuntimeClientFrame,
  type RuntimeHostFrame,
  type RuntimeHostPayload,
  type RuntimeMetadata,
} from "./types.js";

const CLIENT_BACKPRESSURE_BYTES = 1024 * 1024;
const METADATA_DEBOUNCE_MS = 50;
const FINAL_OUTPUT_DRAIN_MS = 3_000;
const CHILD_REPAINT_TIMEOUT_MS = 5_000;
const FORCE_STOP_MS = 8_000;
const ATTACH_RESET = Buffer.from("\u001b[?1049h\u001b[H\u001b[J", "utf8");

function tokensEqual(candidate: string, expected: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(candidate) || !/^[a-f0-9]{64}$/i.test(expected)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
}

interface ActiveClient {
  readonly id: string;
  readonly control: Socket;
  channel?: JsonFrameChannel | undefined;
  terminal?: Socket | undefined;
  output?: TerminalAttachOutput | undefined;
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").trim().slice(0, 300) || "runtime host failed";
}

function authFrame(value: unknown): RuntimeAuthFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Partial<RuntimeAuthFrame>;
  if (
    frame.version !== RUNTIME_PROTOCOL_VERSION ||
    frame.type !== "auth" ||
    !["probe", "client-control", "client-terminal", "child"].includes(
      String(frame.role),
    ) ||
    typeof frame.token !== "string" ||
    (frame.columns !== undefined && typeof frame.columns !== "number") ||
    (frame.rows !== undefined && typeof frame.rows !== "number") ||
    (frame.supportsRepaint !== undefined &&
      typeof frame.supportsRepaint !== "boolean")
  ) {
    return undefined;
  }
  return frame as RuntimeAuthFrame;
}

function terminalDimensions(
  columnsValue: unknown,
  rowsValue: unknown,
): TerminalDimensions | undefined {
  if (
    typeof columnsValue !== "number" ||
    !Number.isFinite(columnsValue) ||
    typeof rowsValue !== "number" ||
    !Number.isFinite(rowsValue)
  ) {
    return undefined;
  }
  const columns = Math.floor(columnsValue);
  const rows = Math.floor(rowsValue);
  if (columns < 20 || columns > 1_000 || rows < 5 || rows > 500) {
    return undefined;
  }
  return { columns, rows };
}

function dimensionsOf(value: RuntimeClientFrame): TerminalDimensions | undefined {
  if (value.type !== "resize") return undefined;
  return terminalDimensions(value.columns, value.rows);
}

export async function resizeRuntimeTransport(
  transport: Pick<SessionTransport, "resize"> | undefined,
  dimensions: TerminalDimensions,
): Promise<boolean> {
  if (!transport?.resize) return true;
  try {
    await transport.resize(dimensions);
    return true;
  } catch {
    return false;
  }
}

function clientFrame(value: unknown): RuntimeClientFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Partial<RuntimeClientFrame>;
  if (frame.type === "ping" || frame.type === "detach") {
    return frame as RuntimeClientFrame;
  }
  if (
    frame.type === "resize" &&
    typeof frame.columns === "number" &&
    typeof frame.rows === "number"
  ) {
    return frame as RuntimeClientFrame;
  }
  return undefined;
}

function childFrame(value: unknown): RuntimeChildFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Partial<RuntimeChildFrame>;
  if (frame.type === "minimise") return frame as RuntimeChildFrame;
  if (
    frame.type === "repaint-result" &&
    typeof frame.requestId === "string" &&
    frame.requestId.length > 0 &&
    frame.requestId.length <= 128 &&
    typeof frame.accepted === "boolean"
  ) {
    return frame as RuntimeChildFrame;
  }
  if (
    frame.type === "exiting" &&
    typeof frame.exitCode === "number" &&
    Number.isSafeInteger(frame.exitCode)
  ) {
    return frame as RuntimeChildFrame;
  }
  if (
    frame.type === "switch" &&
    typeof frame.sessionId === "string" &&
    typeof frame.closeCurrent === "boolean" &&
    (frame.fresh === undefined || typeof frame.fresh === "boolean")
  ) {
    return frame as RuntimeChildFrame;
  }
  if (
    frame.type === "status" &&
    typeof frame.sessionId === "string" &&
    frame.sessionId.length <= 256 &&
    typeof frame.cwd === "string" &&
    frame.cwd.length <= 4096 &&
    typeof frame.busy === "boolean" &&
    (frame.title === undefined ||
      (typeof frame.title === "string" && frame.title.length <= 256))
  ) {
    return frame as RuntimeChildFrame;
  }
  return undefined;
}

function listen(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(path);
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    timer.unref?.();
    server.close(finish);
  });
}

export class SessionRuntimeHost {
  private readonly token = createRuntimeToken();
  private readonly replay = new TerminalReplayBuffer();
  private readonly terminalModes = new TerminalModeState();
  private readonly startedAt = new Date().toISOString();
  private sessionId: string;
  private cwd: string;
  private socketPath: string;
  private title: string | undefined;
  private busy = true;
  private attached = false;
  private phase: RuntimeMetadata["phase"] = "starting";
  private error: string | undefined;
  private lease: RuntimeLease | undefined;
  private server: Server | undefined;
  private readonly connections = new Set<Socket>();
  private transport: SessionTransport | undefined;
  private client: ActiveClient | undefined;
  private childSocket: Socket | undefined;
  private childChannel: JsonFrameChannel | undefined;
  private childSupportsRepaint = false;
  private readonly repaintRequests = new Map<
    string,
    (accepted: boolean) => void
  >();
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private forceTimer: ReturnType<typeof setTimeout> | undefined;
  private livenessTimer: ReturnType<typeof setTimeout> | undefined;
  private livenessMisses = 0;
  private expectedExitCode: number | undefined;
  private metadataTimer: ReturnType<typeof setTimeout> | undefined;
  private metadataDirty = false;
  private outputPausedFor: Socket | undefined;
  private outputDrainHandler: (() => void) | undefined;
  private metadataWrites: Promise<void> = Promise.resolve();
  private inputWrites: Promise<unknown> = Promise.resolve();
  private statusWrites: Promise<unknown> = Promise.resolve();
  private closing = false;
  private cleaning = false;
  private exitOutcome: ProcessOutcome | undefined;
  private resolveExit: ((outcome: ProcessOutcome) => void) | undefined;
  private readonly exitPromise = new Promise<ProcessOutcome>((resolve) => {
    this.resolveExit = resolve;
  });
  private readonly signalHandlers = new Map<NodeJS.Signals, () => void>();

  constructor(private readonly payload: RuntimeHostPayload) {
    this.sessionId = payload.sessionId;
    this.cwd = payload.cwd;
    this.socketPath = runtimeSocketPath(payload.sessionId);
  }

  async run(): Promise<void> {
    this.lease = await tryAcquireRuntimeLease(this.sessionId);
    if (!this.lease && (await reapStaleRuntimeLock(this.sessionId))) {
      this.lease = await tryAcquireRuntimeLease(this.sessionId);
    }
    if (!this.lease) return;
    try {
      await this.startServer();
      await this.writeMetadataNow();
      this.installSignals();
      await this.startChild();
      this.phase = "running";
      this.queueMetadata();
      const outcome = await this.exitPromise;
      this.exitOutcome = outcome;
      await this.flushTerminalOutput();
      this.sendToClient({
        type: "exit",
        exitCode: outcome.exitCode ?? 1,
        ...(outcome.signal ? { signal: outcome.signal } : {}),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (error) {
      this.phase = "failed";
      this.error = errorText(error);
      await this.writeMetadataNow().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    } finally {
      await this.cleanup();
    }
  }

  private async startServer(): Promise<void> {
    if (process.platform !== "win32" && isRuntimeSocketPath(this.socketPath)) {
      await rm(this.socketPath, { force: true }).catch(() => undefined);
    }
    const server = createServer((socket) => void this.accept(socket));
    this.server = server;
    await listen(server, this.socketPath);
    if (process.platform !== "win32") {
      await chmod(this.socketPath, 0o600).catch(() => undefined);
    }
  }

  private async startChild(): Promise<void> {
    const env = { ...process.env };
    delete env[RUNTIME_HOST_ENV];
    env[RUNTIME_CHILD_ENV] = "1";
    env[RUNTIME_SOCKET_ENV] = this.socketPath;
    env[RUNTIME_TOKEN_ENV] = this.token;
    env[RUNTIME_SESSION_ENV] = this.sessionId;
    const result = await startPtyProcess({
      file: this.payload.launch.file,
      args: this.payload.launch.args,
      cwd: this.payload.cwd,
      env,
      dimensions: {
        columns: this.payload.columns,
        rows: this.payload.rows,
      },
    });
    this.transport = result.transport;
    this.transport.onOutput((event) => this.publishOutput(event.bytes));
    this.transport.onExit((outcome) => {
      if (this.exitOutcome) return;
      this.resolveExit?.(outcome);
    });
    this.armChildLiveness();
  }

  private armChildLiveness(): void {
    if (this.exitOutcome || !this.transport) return;
    this.livenessTimer = setTimeout(() => {
      this.livenessTimer = undefined;
      const transport = this.transport;
      if (!transport || this.exitOutcome) return;
      const expected = transport.identity;
      const comparison = expected
        ? processIdentityTracker.compare(transport.pid, expected)
        : processAlive(transport.pid)
          ? "unknown"
          : "gone";
      const provenDead = comparison === "gone" || comparison === "mismatch";
      this.livenessMisses = provenDead ? this.livenessMisses + 1 : 0;
      if (this.livenessMisses >= 2) {
        this.resolveExit?.({
          endedAt: Date.now(),
          exitCode: this.expectedExitCode ?? 1,
        });
        return;
      }
      this.armChildLiveness();
    }, 500);
    this.livenessTimer.unref?.();
  }

  private async accept(socket: Socket): Promise<void> {
    this.connections.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => this.connections.delete(socket));
    socket.setNoDelay(true);
    try {
      const first = await readFirstFrame(socket);
      const auth = authFrame(first.value);
      if (!auth || !tokensEqual(auth.token, this.token)) {
        sendFrame(socket, {
          version: RUNTIME_PROTOCOL_VERSION,
          type: "error",
          message: "authentication failed",
        });
        socket.end();
        return;
      }
      if (auth.role === "probe") {
        this.acknowledge(socket);
        socket.end();
        return;
      }
      if (auth.role === "client-control") {
        this.acceptClientControl(socket, auth, first.rest);
        return;
      }
      if (auth.role === "client-terminal") {
        const hasDimensions =
          auth.columns !== undefined || auth.rows !== undefined;
        const dimensions = terminalDimensions(auth.columns, auth.rows);
        if (hasDimensions && !dimensions) {
          socket.destroy();
          return;
        }
        await this.acceptClientTerminal(socket, auth, first.rest, dimensions);
        return;
      }
      this.acceptChild(socket, auth, first.rest);
    } catch {
      socket.destroy();
    }
  }

  private acknowledge(socket: Socket): void {
    sendFrame(socket, {
      version: RUNTIME_PROTOCOL_VERSION,
      type: "ack",
      sessionId: this.sessionId,
    });
  }

  private acceptClientControl(
    socket: Socket,
    auth: RuntimeAuthFrame,
    rest: Buffer,
  ): void {
    const clientId = auth.clientId?.trim();
    if (!clientId || clientId.length > 128) {
      socket.destroy();
      return;
    }
    if (this.client) {
      this.disconnectClient("taken-over");
    }
    const client: ActiveClient = { id: clientId, control: socket };
    this.client = client;
    this.acknowledge(socket);
    client.channel = new JsonFrameChannel(
      socket,
      (value) => this.handleClientFrame(client, value),
      () => socket.destroy(),
      rest,
    );
    socket.once("close", () => this.clientClosed(client, socket));
  }

  private async acceptClientTerminal(
    socket: Socket,
    auth: RuntimeAuthFrame,
    rest: Buffer,
    dimensions: TerminalDimensions | undefined,
  ): Promise<void> {
    const client = this.client;
    if (!client || !auth.clientId || client.id !== auth.clientId) {
      socket.destroy();
      return;
    }
    if (dimensions && !(await this.resize(dimensions))) {
      socket.destroy();
      return;
    }
    if (this.client !== client) {
      socket.destroy();
      return;
    }
    if (client.terminal) {
      client.output?.dispose();
      this.releaseOutputBackpressure(client.terminal);
      client.terminal.destroy();
    }
    const output = new TerminalAttachOutput(
      this.replay.snapshot(),
      (bytes) => this.writeToTerminal(socket, bytes),
    );
    client.terminal = socket;
    client.output = output;
    this.attached = true;
    this.cancelIdleTimer();
    this.queueMetadata();
    if (rest.length > 0) this.queueInput(rest);
    socket.on("data", (bytes: Buffer) => {
      if (this.client === client && client.terminal === socket) {
        this.queueInput(bytes);
      }
    });
    socket.once("close", () => this.clientClosed(client, socket));
    socket.resume();
    this.acknowledge(socket);
    this.writeToTerminal(socket, ATTACH_RESET);
    const modes = this.terminalModes.restoreSequence();
    if (modes.length > 0) this.writeToTerminal(socket, Buffer.from(modes, "utf8"));
    const repainted = await this.requestChildRepaint();
    output.finish(repainted);
  }

  private acceptChild(
    socket: Socket,
    auth: RuntimeAuthFrame,
    rest: Buffer,
  ): void {
    this.failChildRepaints();
    this.childChannel?.dispose();
    this.childSocket?.destroy();
    this.childSocket = socket;
    this.childSupportsRepaint = auth.supportsRepaint === true;
    this.acknowledge(socket);
    this.childChannel = new JsonFrameChannel(
      socket,
      (value) => this.handleChildFrame(value),
      () => socket.destroy(),
      rest,
    );
    socket.once("close", () => {
      if (this.childSocket !== socket) return;
      this.failChildRepaints();
      this.childChannel?.dispose();
      this.childChannel = undefined;
      this.childSocket = undefined;
      this.childSupportsRepaint = false;
    });
    if (this.client?.terminal) void this.requestChildRepaint();
  }

  private requestChildRepaint(): Promise<boolean> {
    const channel = this.childChannel;
    if (!this.childSupportsRepaint || !channel) return Promise.resolve(false);
    const requestId = randomUUID();
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (accepted: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.repaintRequests.delete(requestId);
        resolve(accepted);
      };
      this.repaintRequests.set(requestId, finish);
      timer = setTimeout(() => finish(false), CHILD_REPAINT_TIMEOUT_MS);
      timer.unref?.();
      if (!channel.send({ type: "repaint", requestId })) finish(false);
    });
  }

  private failChildRepaints(): void {
    for (const finish of [...this.repaintRequests.values()]) finish(false);
  }

  private handleClientFrame(client: ActiveClient, value: unknown): void {
    if (this.client !== client) return;
    const frame = clientFrame(value);
    if (!frame) return;
    if (frame.type === "ping") {
      client.channel?.send({ type: "pong" });
      return;
    }
    if (frame.type === "detach") {
      this.disconnectClient("requested");
      return;
    }
    const dimensions = dimensionsOf(frame);
    if (dimensions) void this.resize(dimensions);
  }

  private handleChildFrame(value: unknown): void {
    const frame = childFrame(value);
    if (!frame) return;
    if (frame.type === "repaint-result") {
      this.repaintRequests.get(frame.requestId)?.(frame.accepted);
      return;
    }
    if (frame.type === "minimise") {
      this.disconnectClient("minimise");
      return;
    }
    if (frame.type === "exiting") {
      this.expectedExitCode = frame.exitCode;
      return;
    }
    if (frame.type === "switch") {
      const target = frame.sessionId.trim();
      if (!target || target.length > 256) return;
      this.sendToClient({
        type: "switch",
        sessionId: target,
        ...(frame.fresh ? { fresh: true } : {}),
      });
      this.closeClientSockets();
      if (frame.closeCurrent) {
        setTimeout(() => this.requestGracefulStop(), 80).unref?.();
      }
      return;
    }
    this.statusWrites = this.statusWrites
      .then(() => this.applyStatus(frame))
      .catch(() => undefined);
  }

  private async applyStatus(
    frame: Extract<RuntimeChildFrame, { type: "status" }>,
  ): Promise<void> {
    let changed = false;
    const nextId = frame.sessionId.trim();
    if (nextId && nextId !== this.sessionId && nextId.length <= 256) {
      const previousId = this.sessionId;
      await this.rebind(nextId);
      changed ||= this.sessionId !== previousId;
    }
    const nextCwd = frame.cwd || this.cwd;
    const nextTitle = frame.title?.trim() || undefined;
    changed ||=
      nextCwd !== this.cwd ||
      nextTitle !== this.title ||
      frame.busy !== this.busy;
    if (!changed) return;
    this.cwd = nextCwd;
    this.title = nextTitle;
    this.busy = frame.busy;
    this.queueMetadata();
    this.scheduleIdleTimer();
  }

  private async rebind(nextId: string): Promise<void> {
    let nextLease = await tryAcquireRuntimeLease(nextId);
    if (!nextLease && (await reapStaleRuntimeLock(nextId))) {
      nextLease = await tryAcquireRuntimeLease(nextId);
    }
    if (!nextLease) return;
    const previousId = this.sessionId;
    const previousLease = this.lease;
    this.sessionId = nextId;
    this.lease = nextLease;
    await this.writeMetadataNow();
    await deleteRuntimeMetadata(previousId);
    await previousLease?.release();
  }

  private publishOutput(bytes: Uint8Array): void {
    this.replay.append(bytes);
    this.terminalModes.observe(bytes);
    this.client?.output?.push(bytes);
  }

  private writeToTerminal(terminal: Socket, bytes: Uint8Array): void {
    if (!terminal.writable || terminal.destroyed) return;
    const writable = terminal.write(bytes);
    if (
      !writable ||
      terminal.writableLength >= CLIENT_BACKPRESSURE_BYTES
    ) {
      this.applyOutputBackpressure(terminal);
    }
  }

  private applyOutputBackpressure(terminal: Socket): void {
    if (this.outputPausedFor === terminal) return;
    this.releaseOutputBackpressure();
    this.outputPausedFor = terminal;
    this.transport?.pauseOutput();
    const drain = (): void => this.releaseOutputBackpressure(terminal);
    this.outputDrainHandler = drain;
    terminal.once("drain", drain);
  }

  private releaseOutputBackpressure(terminal?: Socket): void {
    if (!this.outputPausedFor) return;
    if (terminal && this.outputPausedFor !== terminal) return;
    if (this.outputDrainHandler) {
      this.outputPausedFor.off("drain", this.outputDrainHandler);
    }
    this.outputPausedFor = undefined;
    this.outputDrainHandler = undefined;
    this.transport?.resumeOutput();
  }

  private async flushTerminalOutput(): Promise<void> {
    this.client?.output?.finish(false);
    const deadline = Date.now() + FINAL_OUTPUT_DRAIN_MS;
    while (Date.now() < deadline) {
      const paused = this.outputPausedFor;
      if (paused) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = (): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            paused.off("drain", finish);
            resolve();
          };
          const timeout = setTimeout(
            finish,
            Math.max(1, Math.min(100, deadline - Date.now())),
          );
          timeout.unref?.();
          paused.once("drain", finish);
        });
        continue;
      }
      const remaining = Math.max(1, deadline - Date.now());
      await Promise.race([
        this.transport?.waitForOutputDrain?.() ?? Promise.resolve(),
        new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, remaining);
          timeout.unref?.();
        }),
      ]);
      if (!this.outputPausedFor) break;
    }
    this.releaseOutputBackpressure();
    const terminal = this.client?.terminal;
    if (
      !terminal ||
      terminal.destroyed ||
      terminal.writableEnded ||
      !terminal.writable
    ) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, 1_000);
      timeout.unref?.();
      terminal.once("close", finish);
      terminal.end(finish);
    });
  }

  private queueInput(bytes: Uint8Array): void {
    const copy = Buffer.from(bytes);
    this.inputWrites = this.inputWrites
      .then(() => this.transport?.write(copy))
      .catch(() => undefined);
  }

  private resize(dimensions: TerminalDimensions): Promise<boolean> {
    return resizeRuntimeTransport(this.transport, dimensions);
  }

  private clientClosed(client: ActiveClient, socket: Socket): void {
    if (client.terminal === socket) {
      client.output?.dispose();
      client.output = undefined;
      client.terminal = undefined;
      this.releaseOutputBackpressure(socket);
      if (this.client === client) {
        this.attached = false;
        this.queueMetadata();
        this.scheduleIdleTimer();
      }
    }
    if (client.control === socket) client.channel?.dispose();
    if (this.client !== client) return;
    if (!client.control.destroyed || client.terminal) return;
    this.client = undefined;
    this.attached = false;
    this.queueMetadata();
    this.scheduleIdleTimer();
  }

  private sendToClient(frame: RuntimeHostFrame): void {
    this.client?.channel?.send(frame);
  }

  private disconnectClient(
    reason: Extract<RuntimeHostFrame, { type: "detached" }>["reason"],
  ): void {
    this.sendToClient({
      type: "detached",
      reason,
      sessionId: this.sessionId,
    });
    this.closeClientSockets();
  }

  private closeClientSockets(): void {
    const client = this.client;
    if (!client) return;
    this.client = undefined;
    this.attached = false;
    client.output?.dispose();
    this.releaseOutputBackpressure(client.terminal);
    client.channel?.dispose();
    client.control.end();
    setTimeout(() => client.terminal?.end(), 50).unref?.();
    setTimeout(() => {
      client.terminal?.destroy();
      client.control.destroy();
    }, 250).unref?.();
    this.queueMetadata();
    this.scheduleIdleTimer();
  }

  private scheduleIdleTimer(): void {
    this.cancelIdleTimer();
    if (this.closing || this.attached || this.busy) return;
    this.idleTimer = setTimeout(
      () => this.requestGracefulStop(),
      this.payload.idleTimeoutMs,
    );
    this.idleTimer.unref?.();
    void this.enforceIdleCap();
  }

  private async enforceIdleCap(): Promise<void> {
    await this.writeMetadataNow().catch(() => undefined);
    await enforceIdleRuntimeCap(this.sessionId).catch(() => undefined);
  }

  private cancelIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private requestGracefulStop(): void {
    if (this.closing) return;
    this.closing = true;
    this.phase = "stopping";
    this.cancelIdleTimer();
    this.queueMetadata();
    if (!this.childChannel?.send({ type: "shutdown" })) {
      void this.transport?.requestTreeTermination("graceful");
    }
    this.forceTimer = setTimeout(() => {
      void this.transport?.requestTreeTermination("forceful");
    }, FORCE_STOP_MS);
    this.forceTimer.unref?.();
  }

  private metadataSnapshot(): RuntimeMetadata {
    const now = new Date().toISOString();
    const childPid = this.transport?.pid;
    const childIdentity = this.transport?.identity;
    return {
      version: RUNTIME_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      hostPid: process.pid,
      ...(processIdentityTracker.capture(process.pid)
        ? { hostIdentity: processIdentityTracker.capture(process.pid) }
        : {}),
      ...(childPid ? { childPid } : {}),
      ...(childIdentity ? { childIdentity } : {}),
      socketPath: this.socketPath,
      token: this.token,
      cwd: this.cwd,
      ...(this.title ? { title: this.title } : {}),
      startedAt: this.startedAt,
      updatedAt: now,
      phase: this.phase,
      busy: this.busy,
      attached: this.attached,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  private queueMetadata(): void {
    if (this.cleaning || this.phase === "failed") return;
    this.metadataDirty = true;
    if (this.metadataTimer) return;
    this.metadataTimer = setTimeout(() => {
      this.metadataTimer = undefined;
      this.flushQueuedMetadata();
    }, METADATA_DEBOUNCE_MS);
    this.metadataTimer.unref?.();
  }

  private flushQueuedMetadata(): void {
    if (!this.metadataDirty || this.phase === "failed") return;
    this.metadataDirty = false;
    const snapshot = this.metadataSnapshot();
    this.metadataWrites = this.metadataWrites
      .then(() => writeRuntimeMetadata(snapshot))
      .catch(() => undefined);
  }

  private async writeMetadataNow(): Promise<void> {
    if (this.metadataTimer) {
      clearTimeout(this.metadataTimer);
      this.metadataTimer = undefined;
    }
    this.metadataDirty = false;
    const snapshot = this.metadataSnapshot();
    const write = this.metadataWrites
      .catch(() => undefined)
      .then(() => writeRuntimeMetadata(snapshot));
    this.metadataWrites = write.catch(() => undefined);
    await write;
  }

  private installSignals(): void {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const handler = (): void => this.requestGracefulStop();
      this.signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    if (process.platform !== "win32") {
      const handler = (): void => undefined;
      this.signalHandlers.set("SIGHUP", handler);
      process.on("SIGHUP", handler);
    }
  }

  private removeSignals(): void {
    for (const [signal, handler] of this.signalHandlers) {
      process.off(signal, handler);
    }
    this.signalHandlers.clear();
  }

  private async cleanup(): Promise<void> {
    if (this.cleaning) return;
    this.cleaning = true;
    this.closing = true;
    this.cancelIdleTimer();
    if (this.metadataTimer) clearTimeout(this.metadataTimer);
    this.metadataTimer = undefined;
    this.metadataDirty = false;
    if (this.forceTimer) clearTimeout(this.forceTimer);
    if (this.livenessTimer) clearTimeout(this.livenessTimer);
    this.releaseOutputBackpressure();
    this.removeSignals();
    this.closeClientSockets();
    this.failChildRepaints();
    this.childChannel?.dispose();
    this.childSocket?.destroy();
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    await closeServer(this.server);
    if (!this.exitOutcome && this.transport) {
      await this.transport.requestTreeTermination("forceful").catch(() => undefined);
    }
    await this.transport?.dispose().catch(() => undefined);
    await this.metadataWrites.catch(() => undefined);
    await deleteRuntimeMetadata(this.sessionId);
    await this.lease?.release();
    if (process.platform !== "win32" && isRuntimeSocketPath(this.socketPath)) {
      await rm(this.socketPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function runRuntimeHostFromEnvironment(): Promise<boolean> {
  const encoded = process.env[RUNTIME_HOST_ENV];
  if (!encoded) return false;
  delete process.env[RUNTIME_HOST_ENV];
  const payload = decodeRuntimeHostPayload(encoded);
  if (!payload) throw new Error("invalid session runtime host payload");
  await new SessionRuntimeHost(payload).run();
  return true;
}

export function runtimeHostClientId(): string {
  return `${process.pid}-${randomUUID()}`;
}
