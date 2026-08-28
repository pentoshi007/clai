import { processIdentityTracker } from "../os/process-identity.js";
import {
  supportsProcessGroups,
  terminateProcessTree,
  type TreeSignalOutcome,
} from "../os/process-tree.js";
import { resolveShell } from "../tools/shell.js";
import type { Unsubscribe } from "./runtime.js";
import {
  LaunchFailure,
  ptyControlBytes,
  type DeliveryResult,
  type LaunchIdentity,
  type LaunchRequest,
  type LaunchResult,
  type PtyCapability,
  type SessionTransport,
  type TransportOutput,
} from "./transport.js";
import type {
  ControlInput,
  ProcessOutcome,
  TerminalDimensions,
} from "./types.js";

export interface PtyProcessLike {
  readonly pid: number;
  onData(listener: (data: string | Buffer) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): {
    dispose(): void;
  };
  write(data: string): void;
  resize(columns: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export interface NodePtyModuleLike {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
      name?: string;
      useConpty?: boolean;
    },
  ): PtyProcessLike;
}

interface BunTerminalLike {
  readonly closed: boolean;
  write(data: string | Uint8Array): number;
  resize(columns: number, rows: number): void;
  close(): void;
}

interface BunSubprocessLike {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: number | string): void;
  unref?(): void;
}

interface BunRuntimeLike {
  readonly version?: string;
  readonly Terminal: new (options: {
    cols: number;
    rows: number;
    data: (terminal: BunTerminalLike, data: Uint8Array) => void;
    exit?: (terminal: BunTerminalLike, exitCode: number, signalCode: number | null) => void;
  }) => BunTerminalLike;
  spawn(
    command: string[],
    options: {
      cwd: string;
      env: Record<string, string>;
      terminal: BunTerminalLike;
      detached: true;
    },
  ): BunSubprocessLike;
}

const MODULE_SPECIFIER = "node-pty";
const BUN_RESIZE_RETRY_MS = 60;
let loadPromise: Promise<NodePtyModuleLike | undefined> | undefined;
let loadFailureReason: string | undefined;

function bunRuntime(platform: NodeJS.Platform = process.platform): BunRuntimeLike | undefined {
  if (platform === "win32") return undefined;
  const candidate = (globalThis as typeof globalThis & { Bun?: unknown }).Bun;
  if (!candidate || typeof candidate !== "object") return undefined;
  const runtime = candidate as Partial<BunRuntimeLike>;
  return typeof runtime.Terminal === "function" && typeof runtime.spawn === "function"
    ? (runtime as BunRuntimeLike)
    : undefined;
}

async function loadNodePty(): Promise<NodePtyModuleLike | undefined> {
  loadPromise ??= (async () => {
    try {
      const loaded = (await import(MODULE_SPECIFIER)) as
        | NodePtyModuleLike
        | { default: NodePtyModuleLike };
      const module = "spawn" in loaded ? loaded : loaded.default;
      if (typeof module?.spawn !== "function") {
        loadFailureReason = "node-pty loaded without a usable spawn export";
        return undefined;
      }
      return module;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      loadFailureReason = /cannot find|module not found|could not locate/i.test(message)
        ? "node-pty is not installed for this target"
        : "node-pty native module failed to load for this target";
      return undefined;
    }
  })();
  return await loadPromise;
}

export async function probePtyCapability(
  platform: NodeJS.Platform = process.platform,
): Promise<PtyCapability> {
  if (bunRuntime(platform)) return { available: true, platform };
  const module = await loadNodePty();
  if (module) return { available: true, platform };
  return {
    available: false,
    platform,
    reason:
      loadFailureReason ??
      (platform === "win32"
        ? "No compatible ConPTY transport is available on this target"
        : "No compatible PTY transport is available on this target"),
  };
}

export function resetPtyCapabilityCache(): void {
  loadPromise = undefined;
  loadFailureReason = undefined;
}

abstract class BasePtyTransport implements SessionTransport {
  readonly kind = "pty" as const;
  abstract readonly pid: number;
  abstract readonly processGroupId: number | undefined;
  abstract readonly identity: string | undefined;
  protected readonly outputListeners = new Set<(event: TransportOutput) => void>();
  protected readonly exitListeners = new Set<(outcome: ProcessOutcome) => void>();
  protected readonly pendingOutput: TransportOutput[] = [];
  protected outcome: ProcessOutcome | undefined;
  protected inputClosed = false;
  protected disposed = false;
  private outputGeneration = 0;
  private readonly drainWaiters = new Set<{
    generation: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
  }>();

  abstract write(bytes: Uint8Array): Promise<DeliveryResult>;
  abstract resize(dimensions: TerminalDimensions): Promise<void>;
  abstract pauseOutput(): void;
  abstract resumeOutput(): void;
  abstract requestTreeTermination(kind: "graceful" | "forceful"): Promise<TreeSignalOutcome>;
  abstract dispose(): Promise<void>;

  async control(action: ControlInput): Promise<DeliveryResult> {
    const bytes = ptyControlBytes(action);
    return bytes
      ? await this.write(bytes)
      : { status: "not-delivered", deliveredBytes: 0 };
  }

  async closeInput(): Promise<DeliveryResult> {
    if (this.inputClosed) return { status: "delivered", deliveredBytes: 0 };
    const bytes = ptyControlBytes("eof");
    const result = bytes
      ? await this.write(bytes)
      : ({ status: "delivered", deliveredBytes: 0 } as const);
    this.inputClosed = true;
    return result;
  }

  waitForOutputDrain(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolve) => {
      const waiter = {
        generation: this.outputGeneration,
        timer: setTimeout(() => undefined, 0),
        resolve,
      };
      clearTimeout(waiter.timer);
      this.drainWaiters.add(waiter);
      this.armDrain(waiter);
    });
  }

  private armDrain(waiter: {
    generation: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: () => void;
  }): void {
    waiter.generation = this.outputGeneration;
    waiter.timer = setTimeout(() => {
      if (!this.drainWaiters.has(waiter)) return;
      if (waiter.generation !== this.outputGeneration) {
        this.armDrain(waiter);
        return;
      }
      this.drainWaiters.delete(waiter);
      waiter.resolve();
    }, 25);
  }

  protected settleOutputDrain(): void {
    for (const waiter of this.drainWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    this.drainWaiters.clear();
  }

  onOutput(listener: (event: TransportOutput) => void): Unsubscribe {
    this.outputListeners.add(listener);
    if (this.pendingOutput.length > 0) {
      for (const event of this.pendingOutput.splice(0)) listener(event);
    }
    return () => this.outputListeners.delete(listener);
  }

  onExit(listener: (outcome: ProcessOutcome) => void): Unsubscribe {
    this.exitListeners.add(listener);
    if (this.outcome) queueMicrotask(() => listener(this.outcome!));
    return () => this.exitListeners.delete(listener);
  }

  protected emitOutput(event: TransportOutput): void {
    this.outputGeneration += 1;
    if (this.outputListeners.size === 0) {
      this.pendingOutput.push(event);
      return;
    }
    for (const listener of [...this.outputListeners]) listener(event);
  }

  protected emitExit(outcome: ProcessOutcome): void {
    if (this.outcome) return;
    this.outcome = outcome;
    for (const listener of [...this.exitListeners]) listener(outcome);
  }
}

class NodePtyTransport extends BasePtyTransport {
  readonly pid: number;
  readonly processGroupId: number | undefined;
  readonly identity: string | undefined;
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  constructor(private readonly pty: PtyProcessLike) {
    super();
    this.pid = pty.pid;
    this.processGroupId = supportsProcessGroups() ? pty.pid : undefined;
    this.identity = processIdentityTracker.capture(pty.pid, { refresh: true });
    this.subscriptions.push(
      pty.onData((data) => {
        const bytes =
          typeof data === "string"
            ? new Uint8Array(Buffer.from(data, "utf8"))
            : new Uint8Array(data);
        this.emitOutput({ stream: "terminal", bytes, observedAt: Date.now() });
      }),
      pty.onExit(({ exitCode, signal }) => {
        this.emitExit({
          endedAt: Date.now(),
          exitCode,
          ...(signal !== undefined ? { signal: String(signal) } : {}),
        });
      }),
    );
  }

  async write(bytes: Uint8Array): Promise<DeliveryResult> {
    if (this.inputClosed || this.outcome) {
      return { status: "not-delivered", deliveredBytes: 0 };
    }
    try {
      this.pty.write(Buffer.from(bytes).toString("binary"));
      return { status: "delivered", deliveredBytes: bytes.length };
    } catch (cause) {
      return { status: "unknown", deliveredBytes: 0, cause };
    }
  }

  async resize(dimensions: TerminalDimensions): Promise<void> {
    this.pty.resize(dimensions.columns, dimensions.rows);
  }

  pauseOutput(): void {
    this.pty.pause();
  }

  resumeOutput(): void {
    this.pty.resume();
  }

  async requestTreeTermination(kind: "graceful" | "forceful"): Promise<TreeSignalOutcome> {
    return terminateProcessTree(this.pid, {
      signal: kind === "graceful" ? "SIGTERM" : "SIGKILL",
      ...(this.processGroupId !== undefined ? { processGroupId: this.processGroupId } : {}),
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.settleOutputDrain();
    this.outputListeners.clear();
    this.exitListeners.clear();
    for (const subscription of this.subscriptions.splice(0)) {
      try {
        subscription.dispose();
      } catch {}
    }
    processIdentityTracker.forget(this.pid);
  }
}

class BunPtyTransport extends BasePtyTransport {
  readonly pid: number;
  readonly processGroupId: number | undefined;
  readonly identity: string | undefined;
  private resizeImmediate: ReturnType<typeof setImmediate> | undefined;
  private resizeRetry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly terminal: BunTerminalLike,
    private readonly subprocess: BunSubprocessLike,
  ) {
    super();
    this.pid = subprocess.pid;
    this.processGroupId = supportsProcessGroups() ? subprocess.pid : undefined;
    this.identity = processIdentityTracker.capture(subprocess.pid, { refresh: true });
  }

  receive(data: Uint8Array): void {
    this.emitOutput({
      stream: "terminal",
      bytes: new Uint8Array(data),
      observedAt: Date.now(),
    });
  }

  exited(exitCode: number, signalCode: number | null): void {
    this.emitExit({
      endedAt: Date.now(),
      exitCode,
      ...(signalCode !== null ? { signal: String(signalCode) } : {}),
    });
  }

  async write(bytes: Uint8Array): Promise<DeliveryResult> {
    if (this.inputClosed || this.outcome || this.terminal.closed) {
      return { status: "not-delivered", deliveredBytes: 0 };
    }
    try {
      const deliveredBytes = this.terminal.write(bytes);
      return deliveredBytes === bytes.length
        ? { status: "delivered", deliveredBytes }
        : { status: "unknown", deliveredBytes };
    } catch (cause) {
      return { status: "unknown", deliveredBytes: 0, cause };
    }
  }

  async resize(dimensions: TerminalDimensions): Promise<void> {
    this.terminal.resize(dimensions.columns, dimensions.rows);
    this.scheduleResizeSignal();
  }

  private scheduleResizeSignal(): void {
    if (this.processGroupId === undefined || this.disposed || this.outcome) return;
    if (this.resizeImmediate === undefined) {
      this.resizeImmediate = setImmediate(() => {
        this.resizeImmediate = undefined;
        this.signalResize();
      });
      this.resizeImmediate.unref?.();
    }
    if (this.resizeRetry !== undefined) clearTimeout(this.resizeRetry);
    this.resizeRetry = setTimeout(() => {
      this.resizeRetry = undefined;
      this.signalResize();
    }, BUN_RESIZE_RETRY_MS);
    this.resizeRetry.unref?.();
  }

  private signalResize(): void {
    const processGroupId = this.processGroupId;
    if (processGroupId === undefined || this.disposed || this.outcome) return;
    try {
      process.kill(-processGroupId, "SIGWINCH");
    } catch {}
  }

  pauseOutput(): void {}

  resumeOutput(): void {}

  async requestTreeTermination(kind: "graceful" | "forceful"): Promise<TreeSignalOutcome> {
    return terminateProcessTree(this.pid, {
      signal: kind === "graceful" ? "SIGTERM" : "SIGKILL",
      ...(this.processGroupId !== undefined ? { processGroupId: this.processGroupId } : {}),
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.resizeImmediate !== undefined) clearImmediate(this.resizeImmediate);
    if (this.resizeRetry !== undefined) clearTimeout(this.resizeRetry);
    this.resizeImmediate = undefined;
    this.resizeRetry = undefined;
    this.settleOutputDrain();
    this.outputListeners.clear();
    this.exitListeners.clear();
    if (!this.terminal.closed) this.terminal.close();
    this.subprocess.unref?.();
    processIdentityTracker.forget(this.pid);
  }
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

export interface PtyStartOverrides {
  readonly module?: NodePtyModuleLike | undefined;
  readonly shell?: string | null | undefined;
}

export interface PtyProcessLaunchRequest {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly dimensions: TerminalDimensions;
  readonly onLaunchIdentity?: ((identity: LaunchIdentity) => void) | undefined;
}

async function startNodePtyProcess(
  request: PtyProcessLaunchRequest,
  module: NodePtyModuleLike,
): Promise<LaunchResult> {
  let pty: PtyProcessLike | undefined;
  let transport: NodePtyTransport | undefined;
  try {
    pty = module.spawn(
      request.file,
      [...request.args],
      {
        cwd: request.cwd,
        env: stringEnv({ ...(request.env ?? process.env), TERM: "xterm-256color" }),
        cols: request.dimensions.columns,
        rows: request.dimensions.rows,
        name: "xterm-256color",
        ...(process.platform === "win32" ? { useConpty: true } : {}),
      },
    );
    if (!pty.pid) throw new Error("node-pty returned no pid");
    transport = new NodePtyTransport(pty);
    request.onLaunchIdentity?.({
      pid: transport.pid,
      processGroupId: transport.processGroupId,
      identity: transport.identity,
    });
    return { transport };
  } catch (error) {
    if (pty) {
      try {
        pty.kill();
      } catch {}
    }
    await transport?.dispose().catch(() => undefined);
    throw new LaunchFailure(
      "PTY_SPAWN_FAILED",
      `PTY allocation failed before launch confirmation: ${
        error instanceof Error ? error.name : "unknown"
      }.`,
      Boolean(pty?.pid),
      false,
    );
  }
}

async function startBunPtyProcess(
  request: PtyProcessLaunchRequest,
  runtime: BunRuntimeLike,
): Promise<LaunchResult> {
  let transport: BunPtyTransport | undefined;
  const pendingData: Uint8Array[] = [];
  let pendingExit: { exitCode: number; signalCode: number | null } | undefined;
  let terminal: BunTerminalLike | undefined;
  let subprocess: BunSubprocessLike | undefined;
  try {
    terminal = new runtime.Terminal({
      cols: request.dimensions.columns,
      rows: request.dimensions.rows,
      data: (_terminal, data) => {
        if (transport) transport.receive(data);
        else pendingData.push(new Uint8Array(data));
      },
      exit: (_terminal, exitCode, signalCode) => {
        if (transport) transport.exited(exitCode, signalCode);
        else pendingExit = { exitCode, signalCode };
      },
    });
    subprocess = runtime.spawn(
      [request.file, ...request.args],
      {
        cwd: request.cwd,
        env: stringEnv({ ...(request.env ?? process.env), TERM: "xterm-256color" }),
        terminal,
        detached: true,
      },
    );
    if (!subprocess.pid) throw new Error("Bun.spawn returned no pid");
    transport = new BunPtyTransport(terminal, subprocess);
    request.onLaunchIdentity?.({
      pid: transport.pid,
      processGroupId: transport.processGroupId,
      identity: transport.identity,
    });
    for (const data of pendingData) transport.receive(data);
    if (pendingExit) {
      transport.exited(pendingExit.exitCode, pendingExit.signalCode);
    }
    void subprocess.exited.then(
      (exitCode) => transport?.exited(exitCode, null),
      () => transport?.exited(1, null),
    );
    return { transport };
  } catch (error) {
    try {
      subprocess?.kill("SIGKILL");
    } catch {}
    await transport?.dispose().catch(() => undefined);
    try {
      if (terminal && !terminal.closed) terminal.close();
    } catch {}
    throw new LaunchFailure(
      "PTY_SPAWN_FAILED",
      `Bun PTY allocation failed before launch confirmation: ${
        error instanceof Error ? error.name : "unknown"
      }.`,
      Boolean(subprocess?.pid),
      false,
    );
  }
}

export async function startPtyProcess(
  request: PtyProcessLaunchRequest,
  overrides: Pick<PtyStartOverrides, "module"> = {},
): Promise<LaunchResult> {
  if (overrides.module) {
    return await startNodePtyProcess(request, overrides.module);
  }
  const runtime = bunRuntime();
  if (runtime) return await startBunPtyProcess(request, runtime);
  const module = await loadNodePty();
  if (module) return await startNodePtyProcess(request, module);
  throw new LaunchFailure(
    "PTY_UNAVAILABLE",
    loadFailureReason ?? "PTY capability is unavailable on this target.",
    false,
    false,
  );
}

export async function startPtyTransport(
  request: LaunchRequest & { dimensions: TerminalDimensions },
  overrides: PtyStartOverrides = {},
): Promise<LaunchResult> {
  const shell = overrides.shell === undefined ? resolveShell() : overrides.shell;
  if (!shell) {
    throw new LaunchFailure(
      "SHELL_NOT_FOUND",
      "No usable command shell was found for an interactive session.",
      false,
      false,
    );
  }
  return await startPtyProcess(
    {
      file: shell,
      args:
        process.platform === "win32"
          ? ["/c", request.command]
          : ["-c", request.command],
      cwd: request.cwd,
      dimensions: request.dimensions,
      ...(request.env ? { env: request.env } : {}),
      ...(request.onLaunchIdentity
        ? { onLaunchIdentity: request.onLaunchIdentity }
        : {}),
    },
    overrides.module ? { module: overrides.module } : {},
  );
}
