import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { ResumeTarget } from "../ui-core/bootstrap/session-resume.js";
import { resolveResumeTarget } from "../ui-core/bootstrap/session-resume.js";
import { mintSessionId } from "../app/controllers/session-persistence.js";
import { probePtyCapability } from "../interactive-session/transport-node-pty.js";
import { safeCwd } from "../os/cwd.js";
import { findBunExecutable, isBunRuntime } from "../os/bun-runtime.js";
import { getConfig } from "../store/config.js";
import {
  findLiveRuntime,
  latestLiveRuntime,
  probeRuntime,
} from "./discovery.js";
import { enforceIdleRuntimeCap } from "./reaper.js";
import {
  RUNTIME_CHILD_ENV,
  RUNTIME_DISABLE_ENV,
  RUNTIME_HOST_ENV,
  RUNTIME_SESSION_ENV,
  RUNTIME_SOCKET_ENV,
  RUNTIME_TOKEN_ENV,
  encodeRuntimeHostPayload,
  selfLaunchSpec,
} from "./launch.js";
import {
  JsonFrameChannel,
  connectRuntimeSocket,
  readFirstFrame,
  sendFrame,
} from "./protocol.js";
import { readRuntimeMetadata } from "./store.js";
import { TERMINAL_MODE_RESET } from "../os/screen-sequences.js";
import { ALT_SCREEN_OFF, AltScreenTracker } from "./alt-screen.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeAckFrame,
  type RuntimeAuthFrame,
  type RuntimeHostFrame,
  type RuntimeHostPayload,
  type RuntimeMetadata,
} from "./types.js";

const START_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1_000;
const MIN_IDLE_TIMEOUT_MS = 60_000;
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const TERMINAL_RESTORE = TERMINAL_MODE_RESET;

export function terminalRestoreSequence(altScreenActive: boolean): string {
  return altScreenActive ? `${TERMINAL_RESTORE}${ALT_SCREEN_OFF}` : TERMINAL_RESTORE;
}

interface RuntimeTarget {
  readonly sessionId: string;
  readonly resumeId?: string | undefined;
  readonly resumeLatest?: boolean | undefined;
}

type AttachOutcome =
  | { readonly kind: "exit"; readonly exitCode: number }
  | {
      readonly kind: "detach";
      readonly reason: "minimise" | "requested" | "taken-over" | "connection-lost";
      readonly sessionId: string;
    }
  | { readonly kind: "switch"; readonly sessionId: string; readonly fresh: boolean };

export interface DurableInteractiveOptions {
  readonly entryPath: string;
  readonly childArgs: readonly string[];
  readonly resume?: ResumeTarget | undefined;
  readonly noHistory?: boolean | undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalColumns(): number {
  return Math.max(20, Math.min(1_000, process.stdout.columns ?? 100));
}

function terminalRows(): number {
  return Math.max(5, Math.min(500, process.stdout.rows ?? 30));
}

function idleTimeoutMs(): number {
  const configured = Number(process.env.CLAI_SESSION_RUNTIME_IDLE_MS);
  if (!Number.isFinite(configured)) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.max(
    MIN_IDLE_TIMEOUT_MS,
    Math.min(MAX_IDLE_TIMEOUT_MS, Math.floor(configured)),
  );
}

function hostFrame(value: unknown): RuntimeHostFrame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const frame = value as Partial<RuntimeHostFrame>;
  if (frame.type === "switch" && typeof frame.sessionId === "string") {
    return frame as RuntimeHostFrame;
  }
  if (
    frame.type === "detached" &&
    typeof frame.sessionId === "string" &&
    ["minimise", "requested", "taken-over", "connection-lost"].includes(
      String(frame.reason),
    )
  ) {
    return frame as RuntimeHostFrame;
  }
  if (frame.type === "exit" && typeof frame.exitCode === "number") {
    return frame as RuntimeHostFrame;
  }
  if (frame.type === "pong") return frame as RuntimeHostFrame;
  return undefined;
}

function isAck(value: unknown): value is RuntimeAckFrame {
  if (!value || typeof value !== "object") return false;
  const frame = value as Partial<RuntimeAckFrame>;
  return (
    frame.version === RUNTIME_PROTOCOL_VERSION &&
    frame.type === "ack" &&
    typeof frame.sessionId === "string"
  );
}

export function runtimeClientAuthFrame(
  metadata: Pick<RuntimeMetadata, "token">,
  role: "client-control" | "client-terminal",
  clientId: string,
  dimensions?: { readonly columns: number; readonly rows: number } | undefined,
): RuntimeAuthFrame {
  return {
    version: RUNTIME_PROTOCOL_VERSION,
    type: "auth",
    role,
    token: metadata.token,
    clientId,
    ...(role === "client-terminal" && dimensions ? dimensions : {}),
  };
}

async function openChannel(
  metadata: RuntimeMetadata,
  role: "client-control" | "client-terminal",
  clientId: string,
  dimensions?: { readonly columns: number; readonly rows: number } | undefined,
): Promise<{ socket: Socket; first: Awaited<ReturnType<typeof readFirstFrame>> }> {
  const socket = await connectRuntimeSocket(metadata.socketPath);
  socket.on("error", () => socket.destroy());
  try {
    sendFrame(
      socket,
      runtimeClientAuthFrame(metadata, role, clientId, dimensions),
    );
    const first = await readFirstFrame(socket);
    if (!isAck(first.value)) {
      throw new Error("session runtime rejected the client connection");
    }
    return { socket, first };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function childEnvironment(payload: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[RUNTIME_CHILD_ENV];
  delete env[RUNTIME_SOCKET_ENV];
  delete env[RUNTIME_TOKEN_ENV];
  delete env[RUNTIME_SESSION_ENV];
  env[RUNTIME_HOST_ENV] = payload;
  return env;
}

function brokerLaunch(entryPath: string) {
  if (!isBunRuntime() && process.platform !== "win32") {
    const bun = findBunExecutable();
    if (bun) return { file: bun, args: [entryPath] };
  }
  return selfLaunchSpec(entryPath, []);
}

async function startRuntimeHost(
  options: DurableInteractiveOptions,
  target: RuntimeTarget,
): Promise<RuntimeMetadata> {
  const childArgs = [
    ...options.childArgs,
    ...(target.resumeId ? ["--resume", target.resumeId] : []),
    ...(target.resumeLatest ? ["--continue"] : []),
  ];
  const childLaunch = selfLaunchSpec(options.entryPath, childArgs);
  const payload: RuntimeHostPayload = {
    version: RUNTIME_PROTOCOL_VERSION,
    sessionId: target.sessionId,
    cwd: safeCwd(),
    launch: childLaunch,
    columns: terminalColumns(),
    rows: terminalRows(),
    idleTimeoutMs: idleTimeoutMs(),
  };
  const hostLaunch = brokerLaunch(options.entryPath);
  const child = spawn(hostLaunch.file, [...hostLaunch.args], {
    cwd: payload.cwd,
    env: childEnvironment(encodeRuntimeHostPayload(payload)),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  let launchError: Error | undefined;
  child.once("error", (error) => {
    launchError = error;
  });
  child.unref();

  let ready = false;
  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (launchError) throw launchError;
      const metadata = await readRuntimeMetadata(target.sessionId);
      if (metadata?.phase === "failed") {
        throw new Error(metadata.error ?? "session runtime failed to start");
      }
      if (
        metadata?.phase === "running" &&
        (await probeRuntime(metadata))
      ) {
        ready = true;
        return metadata;
      }
      const winner = await findLiveRuntime(target.sessionId).catch(() => undefined);
      if (winner?.phase === "running") {
        ready = true;
        return winner;
      }
      await delay(50);
    }
    throw new Error("session runtime did not become ready within 10 seconds");
  } finally {
    if (!ready && child.pid && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }
}

async function ensureRuntime(
  options: DurableInteractiveOptions,
  target: RuntimeTarget,
): Promise<RuntimeMetadata> {
  const existing = await findLiveRuntime(target.sessionId);
  if (existing?.phase === "failed") {
    throw new Error(existing.error ?? "session runtime failed");
  }
  if (existing) return existing;
  const started = await startRuntimeHost(options, target);
  void enforceIdleRuntimeCap(started.sessionId).catch(() => undefined);
  return started;
}

async function initialTarget(
  resume: ResumeTarget | undefined,
): Promise<RuntimeTarget> {
  if (!resume) return { sessionId: mintSessionId() };
  if (resume.kind === "latest") {
    const live = await latestLiveRuntime(safeCwd());
    if (live) return { sessionId: live.sessionId };
    const resolved = await resolveResumeTarget(resume);
    if (resolved.record) {
      return { sessionId: resolved.record.id, resumeId: resolved.record.id };
    }
    return { sessionId: mintSessionId(), resumeLatest: true };
  }
  const live = await findLiveRuntime(resume.id);
  if (live) return { sessionId: live.sessionId };
  const resolved = await resolveResumeTarget(resume);
  if (resolved.record) {
    return { sessionId: resolved.record.id, resumeId: resolved.record.id };
  }
  return { sessionId: mintSessionId(), resumeId: resume.id };
}

async function switchTarget(
  sessionId: string,
  fresh: boolean,
): Promise<RuntimeTarget> {
  const live = await findLiveRuntime(sessionId);
  if (live) return { sessionId: live.sessionId };
  if (fresh) return { sessionId };
  const resolved = await resolveResumeTarget({ kind: "id", id: sessionId });
  if (!resolved.record) {
    throw new Error(resolved.error ?? `session ${sessionId} is unavailable`);
  }
  return { sessionId: resolved.record.id, resumeId: resolved.record.id };
}

function writeOutput(tracker: AltScreenTracker, bytes: Uint8Array): boolean {
  tracker.observe(bytes);
  return process.stdout.write(bytes);
}

function waitForTerminalEnd(socket: Socket, timeoutMs = 3_000): Promise<void> {
  if (socket.destroyed || socket.readableEnded) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("end", finish);
      socket.off("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    socket.once("end", finish);
    socket.once("close", finish);
  });
}

function waitForStdoutDrain(timeoutMs = 1_000): Promise<void> {
  if (!process.stdout.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdout.off("drain", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdout.once("drain", finish);
  });
}

function resetTerminal(tracker: AltScreenTracker): Promise<void> {
  const sequence = terminalRestoreSequence(tracker.isActive);
  tracker.observe(sequence);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdout.off("error", finish);
      resolve();
    };
    const timer = setTimeout(finish, 1_000);
    process.stdout.once("error", finish);
    try {
      process.stdout.write(sequence, (error) => {
        if (!error) finish();
      });
    } catch {
      finish();
    }
  });
}

async function attachRuntime(
  metadata: RuntimeMetadata,
  altScreen: AltScreenTracker,
  signal: AbortSignal,
): Promise<AttachOutcome> {
  const clientId = `${process.pid}-${randomUUID()}`;
  const dimensions = {
    columns: terminalColumns(),
    rows: terminalRows(),
  };
  const controlConnection = await openChannel(
    metadata,
    "client-control",
    clientId,
  );
  let terminalConnection: Awaited<ReturnType<typeof openChannel>>;
  try {
    terminalConnection = await openChannel(
      metadata,
      "client-terminal",
      clientId,
      dimensions,
    );
  } catch (error) {
    controlConnection.socket.destroy();
    throw error;
  }
  const control = controlConnection.socket;
  const terminal = terminalConnection.socket;
  let settled = false;
  let exitPending = false;
  let channel: JsonFrameChannel | undefined;
  let controlCloseTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveOutcome: ((value: AttachOutcome) => void) | undefined;
  const outcome = new Promise<AttachOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  const settle = (value: AttachOutcome): void => {
    if (settled) return;
    settled = true;
    resolveOutcome?.(value);
  };
  const receive = (value: unknown): void => {
    const frame = hostFrame(value);
    if (!frame || frame.type === "pong") return;
    if (frame.type === "switch") {
      settle({ kind: "switch", sessionId: frame.sessionId, fresh: frame.fresh === true });
      return;
    }
    if (frame.type === "detached") {
      settle({
        kind: "detach",
        reason: frame.reason,
        sessionId: frame.sessionId,
      });
      return;
    }
    if (frame.type === "exit" && !exitPending) {
      exitPending = true;
      void (async () => {
        await waitForTerminalEnd(terminal);
        await waitForStdoutDrain();
        settle({ kind: "exit", exitCode: frame.exitCode });
      })();
    }
  };
  const onControlClose = (): void => {
    controlCloseTimer = setTimeout(() => {
      if (!settled && !exitPending) {
        settle({
          kind: "detach",
          reason: "connection-lost",
          sessionId: metadata.sessionId,
        });
      }
    }, 30).unref?.();
  };

  const stdin = process.stdin;
  const onInput = (bytes: Buffer): void => {
    if (settled || exitPending) return;
    if (!terminal.write(bytes)) stdin.pause();
  };
  const onTerminalDrain = (): void => {
    if (!settled && !exitPending) stdin.resume();
  };
  const onTerminalError = (): void => {
    if (exitPending) return;
    settle({
      kind: "detach",
      reason: "connection-lost",
      sessionId: metadata.sessionId,
    });
  };
  const onOutput = (bytes: Buffer): void => {
    if (settled) return;
    if (!writeOutput(altScreen, bytes)) terminal.pause();
  };
  const onStdoutDrain = (): void => {
    terminal.resume();
  };
  const onInputEnd = (): void => {
    settle({
      kind: "detach",
      reason: "connection-lost",
      sessionId: metadata.sessionId,
    });
  };
  const sendResize = (): void => {
    channel?.send({
      type: "resize",
      columns: terminalColumns(),
      rows: terminalRows(),
    });
  };
  const onTerminate = (): void => onInputEnd();

  try {
    channel = new JsonFrameChannel(
      control,
      receive,
      onTerminalError,
      controlConnection.first.rest,
    );
    control.once("close", onControlClose);
    stdin.on("data", onInput);
    stdin.once("end", onInputEnd);
    terminal.on("drain", onTerminalDrain);
    terminal.on("error", onTerminalError);
    terminal.on("data", onOutput);
    process.stdout.on("drain", onStdoutDrain);
    process.on("SIGWINCH", sendResize);
    signal.addEventListener("abort", onTerminate, { once: true });
    if (signal.aborted) onTerminate();
    if (!settled) {
      const writable = terminalConnection.first.rest.length === 0 ||
        writeOutput(altScreen, terminalConnection.first.rest);
      if (writable) terminal.resume();
      sendResize();
    }
    return await outcome;
  } finally {
    settled = true;
    channel?.dispose();
    if (controlCloseTimer) clearTimeout(controlCloseTimer);
    control.off("close", onControlClose);
    stdin.off("data", onInput);
    stdin.off("end", onInputEnd);
    terminal.off("drain", onTerminalDrain);
    terminal.off("error", onTerminalError);
    terminal.off("data", onOutput);
    process.stdout.off("drain", onStdoutDrain);
    process.off("SIGWINCH", sendResize);
    signal.removeEventListener("abort", onTerminate);
    control.destroy();
    terminal.destroy();
    stdin.resume();
  }
}

async function runRuntimeClient(
  options: DurableInteractiveOptions,
): Promise<Exclude<AttachOutcome, { kind: "switch" }>> {
  const stdin = process.stdin;
  const previousRaw = stdin.isRaw;
  const altScreen = new AltScreenTracker();
  const discardInput = (): void => undefined;
  const controller = new AbortController();
  let interrupted: Extract<AttachOutcome, { kind: "exit" }> | undefined;
  const interrupt = (exitCode: number): void => {
    interrupted ??= { kind: "exit", exitCode };
    controller.abort();
  };
  const onHangup = (): void => interrupt(129);
  const onTerminate = (): void => interrupt(143);
  try {
    process.on("SIGHUP", onHangup);
    process.on("SIGTERM", onTerminate);
    stdin.on("data", discardInput);
    stdin.setRawMode?.(true);
    stdin.resume();
    let target = await initialTarget(options.resume);
    for (;;) {
      if (interrupted) return interrupted;
      const metadata = await ensureRuntime(options, target);
      if (interrupted) return interrupted;
      const outcome = await attachRuntime(metadata, altScreen, controller.signal);
      if (interrupted) return interrupted;
      if (outcome.kind !== "switch") return outcome;
      await resetTerminal(altScreen);
      try {
        target = await switchTarget(outcome.sessionId, outcome.fresh);
      } catch (error) {
        const current = await findLiveRuntime(metadata.sessionId).catch(
          () => undefined,
        );
        if (!current) throw error;
        process.stderr.write(
          `Unable to switch sessions (${runtimeFallbackMessage(error)}); reattaching the current session.\n`,
        );
        target = { sessionId: current.sessionId };
      }
    }
  } catch (error) {
    if (interrupted) return interrupted;
    throw error;
  } finally {
    try {
      await resetTerminal(altScreen);
    } finally {
      stdin.pause();
      stdin.off("data", discardInput);
      try {
        stdin.setRawMode?.(previousRaw ?? false);
      } finally {
        process.off("SIGHUP", onHangup);
        process.off("SIGTERM", onTerminate);
      }
    }
  }
}

function reportDetach(outcome: Extract<AttachOutcome, { kind: "detach" }>): void {
  const resume = `clai --resume ${outcome.sessionId}`;
  if (outcome.reason === "minimise" || outcome.reason === "requested") {
    process.stdout.write(
      `\nSession ${outcome.sessionId} is running in the background.\nReattach with: ${resume}\n`,
    );
    return;
  }
  if (outcome.reason === "taken-over") {
    process.stdout.write(
      `\nSession ${outcome.sessionId} was attached from another terminal.\n`,
    );
    return;
  }
  process.stdout.write(
    `\nConnection to session ${outcome.sessionId} closed. Reattach with: ${resume}\n`,
  );
}

function runtimeEligible(options: DurableInteractiveOptions): boolean {
  return (
    process.env[RUNTIME_CHILD_ENV] !== "1" &&
    process.env[RUNTIME_HOST_ENV] === undefined &&
    process.env[RUNTIME_DISABLE_ENV] !== "1" &&
    options.noHistory !== true &&
    !getConfig().privateMode &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY)
  );
}

function runtimeFallbackMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const compact = detail.replace(/\s+/g, " ").trim().slice(0, 300);
  return compact || "unknown runtime error";
}

export async function tryRunDurableInteractive(
  options: DurableInteractiveOptions,
): Promise<boolean> {
  if (!runtimeEligible(options)) return false;
  try {
    const capability = await probePtyCapability();
    if (!capability.available) return false;

    const outcome = await runRuntimeClient(options);
    if (outcome.kind === "exit") {
      process.exitCode = outcome.exitCode;
      return true;
    }
    reportDetach(outcome);
    return true;
  } catch (error) {
    process.stderr.write(
      `Durable session runtime unavailable (${runtimeFallbackMessage(error)}); using foreground mode.\n`,
    );
    return false;
  }
}
