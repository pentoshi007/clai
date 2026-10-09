import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { execa } from "execa";
import { supportsProcessGroups, terminateProcessTree } from "../os/process-tree.js";
import { createNotification, encodeLine, LineDecoder, parseMessage } from "./jsonrpc.js";
import {
  isAbortError,
  awaitMcpOperation,
  dispatchServerMessage,
  McpTransportError,
  withTimeout,
  type McpTransport,
  type McpTransportHandlers,
} from "./transport.js";
import type {
  JsonRpcNotification,
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  McpRequestOptions,
  McpStdioConfig,
} from "./types.js";
import { isJsonRpcResponse } from "./jsonrpc.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_GRACE_MS = 2_000;
const MAX_STDERR_BYTES = 64 * 1024;

interface PendingRequest {
  resolve(response: JsonRpcResponse): void;
  reject(error: Error): void;
  dispose(): void;
}

export interface StdioTransportOptions {
  readonly requestTimeoutMs?: number | undefined;
  readonly closeGraceMs?: number | undefined;
  readonly baseEnv?: Readonly<Record<string, string | undefined>> | undefined;
}

export class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;

  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly decoder = new LineDecoder();
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private exited = false;
  private stderrTail = "";
  private processGroupId: number | undefined;
  private protocolVersion: string | undefined;
  private startPromise: Promise<void> | undefined;
  private handlers: McpTransportHandlers | undefined;

  constructor(
    private readonly config: McpStdioConfig,
    private readonly options: StdioTransportOptions = {},
  ) {}

  sessionId(): string | undefined {
    return undefined;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  setHandlers(handlers: McpTransportHandlers): void {
    this.handlers = handlers;
  }

  start(): Promise<void> {
    if (this.closed)
      return Promise.reject(new McpTransportError("closed", "MCP stdio transport closed."));
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.spawnChild();
    return this.startPromise;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const base = this.options.baseEnv ?? process.env;
    const merged: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(base)) {
      if (typeof value === "string") merged[key] = value;
    }
    for (const [key, value] of Object.entries(this.config.env)) {
      merged[key] = value;
    }
    return merged;
  }

  private spawnChild(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        const subprocess = execa(this.config.command, [...this.config.args], {
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          buffer: false,
          reject: false,
          cleanup: false,
          env: this.buildEnv(),
          detached: supportsProcessGroups(),
          windowsHide: true,
          ...(this.config.cwd !== undefined ? { cwd: this.config.cwd } : {}),
        });
        void subprocess.catch(() => undefined);
        child = subprocess as unknown as ChildProcessWithoutNullStreams;
      } catch (error) {
        reject(
          new McpTransportError(
            "spawn",
            `Failed to spawn MCP server "${this.config.command}": ${(error as Error).message}`,
          ),
        );
        return;
      }
      this.child = child;
      this.processGroupId = supportsProcessGroups() ? child.pid : undefined;

      let settled = false;
      const onSpawn = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const onError = (error: Error): void => {
        if (settled) {
          this.failAll(new McpTransportError("network", error.message));
          return;
        }
        settled = true;
        child.off("spawn", onSpawn);
        reject(
          new McpTransportError(
            "spawn",
            `MCP server "${this.config.command}" failed to start: ${error.message}`,
          ),
        );
      };
      child.once("spawn", onSpawn);
      child.on("error", onError);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
      child.stdin.on("error", (error) =>
        this.failAll(new McpTransportError("closed", `MCP server input closed: ${error.message}`)),
      );
      child.on("exit", () => {
        this.exited = true;
        this.failAll(
          new McpTransportError(
            "closed",
            this.stderrTail.trim().length > 0
              ? `MCP server exited: ${this.stderrTail.trim().slice(-400)}`
              : "MCP server process exited.",
          ),
        );
      });
    });
  }

  private onStdout(chunk: string): void {
    let lines: string[];
    try {
      lines = this.decoder.push(chunk);
    } catch (error) {
      const failure =
        error instanceof McpTransportError
          ? error
          : new McpTransportError(
              "protocol",
              `MCP stdio framing error: ${(error as Error).message}`,
            );
      this.failAll(failure);
      void this.close();
      return;
    }
    for (const line of lines) {
      const message = parseMessage(line);
      if (!message) continue;
      if (!isJsonRpcResponse(message)) {
        void dispatchServerMessage(message, this.handlers, (response) =>
          this.write(response),
        ).catch(() => undefined);
        continue;
      }
      const numericId = typeof message.id === "number" ? message.id : Number(message.id);
      if (!Number.isFinite(numericId)) continue;
      const entry = this.pending.get(numericId);
      if (!entry) continue;
      this.pending.delete(numericId);
      entry.dispose();
      entry.resolve(message);
    }
  }

  private onStderr(chunk: string): void {
    this.stderrTail = (this.stderrTail + chunk).slice(-MAX_STDERR_BYTES);
  }

  private failAll(error: Error): void {
    for (const [, entry] of this.pending) {
      entry.dispose();
      entry.reject(error);
    }
    this.pending.clear();
  }

  private write(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (this.closed || this.exited || !child || child.stdin.destroyed) {
      return Promise.reject(
        new McpTransportError("closed", "MCP stdio transport is not connected."),
      );
    }
    return new Promise((resolve, reject) => {
      child.stdin.write(encodeLine(message), (error) => {
        if (error)
          reject(new McpTransportError("closed", `Failed to write MCP message: ${error.message}`));
        else resolve();
      });
    });
  }

  async request(
    message: JsonRpcRequest,
    options: McpRequestOptions = {},
  ): Promise<JsonRpcResponse> {
    if (options.signal?.aborted) throw new McpTransportError("cancelled", "MCP request cancelled.");
    const timeoutMs =
      options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const { signal, dispose } = withTimeout(options.signal, timeoutMs);
    try {
      await awaitMcpOperation(this.start(), signal);
      if (this.closed || this.exited || !this.child) {
        throw new McpTransportError("closed", "MCP stdio transport is not connected.");
      }
      const id = this.nextId++;
      const framed: JsonRpcRequest = { ...message, id };
      return await new Promise<JsonRpcResponse>((resolve, reject) => {
        const onAbort = (): void => {
          const entry = this.pending.get(id);
          if (entry) {
            this.pending.delete(id);
            entry.dispose();
            if (message.method !== "initialize") {
              void this.write(
                createNotification("notifications/cancelled", {
                  requestId: id,
                  reason: "Client stopped waiting for this request.",
                }),
              ).catch(() => undefined);
            }
          }
          const reason = signal.reason;
          if (reason instanceof McpTransportError) reject(reason);
          else reject(new McpTransportError("cancelled", "MCP request cancelled."));
        };
        const disposeEntry = (): void => {
          dispose();
          signal.removeEventListener("abort", onAbort);
        };
        if (signal.aborted) {
          disposeEntry();
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        this.pending.set(id, { resolve, reject, dispose: disposeEntry });
        void this.write(framed).catch((error: unknown) => {
          this.pending.delete(id);
          disposeEntry();
          reject(error);
        });
      });
    } finally {
      dispose();
    }
  }

  async notify(message: JsonRpcNotification, options: McpRequestOptions = {}): Promise<void> {
    if (options.signal?.aborted)
      throw new McpTransportError("cancelled", "MCP notification cancelled.");
    const timeoutMs =
      options.timeoutMs ?? this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const { signal, dispose } = withTimeout(options.signal, timeoutMs);
    try {
      await awaitMcpOperation(this.start(), signal);
      await awaitMcpOperation(this.write(message), signal);
    } finally {
      dispose();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.failAll(new McpTransportError("closed", "MCP stdio transport closed."));
    if (!child || this.exited) {
      this.disposeChild();
      return;
    }
    try {
      child.stdin.end();
    } catch {
      void 0;
    }
    const graceMs = this.options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    const exitedGracefully = await this.waitForExit(child, graceMs, "SIGTERM");
    if (!exitedGracefully) {
      this.forceKill(child);
      await this.waitForExit(child, graceMs, undefined);
    }
    this.disposeChild();
  }

  private waitForExit(
    child: ChildProcessWithoutNullStreams,
    graceMs: number,
    signal: "SIGTERM" | undefined,
  ): Promise<boolean> {
    if (this.exited || child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        child.off("exit", onExit);
        resolve(false);
      }, graceMs);
      if (typeof timer.unref === "function") timer.unref();
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      child.once("exit", onExit);
      if (signal && child.pid) {
        terminateProcessTree(child.pid, {
          signal,
          ...(this.processGroupId !== undefined ? { processGroupId: this.processGroupId } : {}),
        });
      }
    });
  }

  private forceKill(child: ChildProcessWithoutNullStreams): void {
    if (!child.pid) return;
    terminateProcessTree(child.pid, {
      signal: "SIGKILL",
      ...(this.processGroupId !== undefined ? { processGroupId: this.processGroupId } : {}),
    });
  }

  private disposeChild(): void {
    const child = this.child;
    if (!child) return;
    try {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    } catch {
      void 0;
    }
    child.removeAllListeners();
    this.child = undefined;
  }

  diagnostics(): string {
    return this.stderrTail.trim();
  }
}

export function isTransportAbort(error: unknown): boolean {
  return isAbortError(error);
}
