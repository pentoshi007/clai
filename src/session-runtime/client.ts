import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { ResumeTarget } from "../ui-core/bootstrap/session-resume.js";
import { resolveResumeTarget } from "../ui-core/bootstrap/session-resume.js";
import { mintSessionId } from "../app/controllers/session-persistence.js";
import { setRuntimeDetachUnavailableReason } from "./availability.js";
import { safeCwd } from "../os/cwd.js";
import { getConfig } from "../store/config.js";
import { listSessionSummaries } from "../store/history.js";
import {
  findLiveRuntime,
  latestLiveRuntime,
  probeRuntime,
} from "./discovery.js";
import { enforceIdleRuntimeCap } from "./reaper.js";
import { runtimeInputCommand } from "./input-commands.js";
import { RuntimeInputStream } from "./input-stream.js";
import {
  RUNTIME_CHILD_ENV,
  RUNTIME_DISABLE_ENV,
  RUNTIME_HOST_ENV,
} from "./launch.js";
import {
  JsonFrameChannel,
  connectRuntimeSocket,
  readFirstFrame,
  sendFrame,
} from "./protocol.js";
import { TERMINAL_MODE_RESET } from "../os/screen-sequences.js";
import { ALT_SCREEN_OFF, AltScreenTracker } from "./alt-screen.js";
import {
  RUNTIME_PROTOCOL_VERSION,
  type RuntimeAckFrame,
  type RuntimeAuthFrame,
  type RuntimeHostFrame,
  type RuntimeMetadata,
  type RuntimeTerminalOptions,
} from "./types.js";
import { runtimeTerminalOptions } from "./terminal-options.js";
import { startRuntimeHost, type RuntimeTarget } from "./startup.js";

const TERMINAL_RESTORE = TERMINAL_MODE_RESET;

export function terminalRestoreSequence(altScreenActive: boolean): string {
  return altScreenActive ? `${TERMINAL_RESTORE}${ALT_SCREEN_OFF}` : TERMINAL_RESTORE;
}

type AttachOutcome =
  | { readonly kind: "exit"; readonly exitCode: number }
  | {
      readonly kind: "detach";
      readonly reason: "minimise" | "requested" | "taken-over" | "connection-lost";
      readonly sessionId: string;
    }
  | { readonly kind: "switch"; readonly sessionId: string; readonly fresh: boolean };

class LiveRuntimeAttachError extends Error {
  constructor(readonly sessionId: string, cause: unknown) {
    super(`Could not attach to live session ${sessionId}: ${runtimeFallbackMessage(cause)}`, { cause });
  }
}

export interface DurableInteractiveOptions {
  readonly entryPath: string;
  readonly childArgs: readonly string[];
  readonly resume?: ResumeTarget | undefined;
  readonly noHistory?: boolean | undefined;
  readonly ui?: RuntimeTerminalOptions["ui"] | undefined;
}

function terminalColumns(): number {
  return Math.max(20, Math.min(1_000, process.stdout.columns ?? 100));
}

function terminalRows(): number {
  return Math.max(5, Math.min(500, process.stdout.rows ?? 30));
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
  if (frame.type === "input-owner" && typeof frame.active === "boolean") return frame as RuntimeHostFrame;
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
  terminal?: RuntimeTerminalOptions | undefined,
): RuntimeAuthFrame {
  return {
    version: RUNTIME_PROTOCOL_VERSION,
    type: "auth",
    role,
    token: metadata.token,
    clientId,
    ...(role === "client-terminal" && dimensions ? dimensions : {}),
    ...(role === "client-terminal" && terminal ? { terminal } : {}),
  };
}

async function openChannel(
  metadata: RuntimeMetadata,
  role: "client-control" | "client-terminal",
  clientId: string,
  dimensions?: { readonly columns: number; readonly rows: number } | undefined,
  terminal?: RuntimeTerminalOptions | undefined,
): Promise<{ socket: Socket; first: Awaited<ReturnType<typeof readFirstFrame>> }> {
  const socket = await connectRuntimeSocket(metadata.socketPath);
  socket.on("error", () => socket.destroy());
  try {
    sendFrame(
      socket,
      runtimeClientAuthFrame(metadata, role, clientId, dimensions, terminal),
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
    if (resume.scope === "global") {
      const [live, summaries] = await Promise.all([
        latestLiveRuntime(),
        listSessionSummaries(1, { recovery: "blocking" }),
      ]);
      const saved = summaries[0];
      if (live && (!saved || live.sessionId === saved.id || live.updatedAt >= saved.updatedAt)) {
        return { sessionId: live.sessionId };
      }
      if (saved) return { sessionId: saved.id, resumeId: saved.id, cwd: saved.cwd };
      return { sessionId: mintSessionId(), resumeLatest: "global" };
    }
    const live = await latestLiveRuntime(safeCwd());
    if (live) return { sessionId: live.sessionId };
    const resolved = await resolveResumeTarget(resume);
    if (resolved.record) {
      return { sessionId: resolved.record.id, resumeId: resolved.record.id };
    }
    return { sessionId: mintSessionId(), resumeLatest: "directory" };
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
  ui: RuntimeTerminalOptions["ui"] = "auto",
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
      metadata.independentViews ? runtimeTerminalOptions(ui) : undefined,
    );
  } catch (error) {
    controlConnection.socket.destroy();
    throw error;
  }
  const control = controlConnection.socket;
  const terminal = terminalConnection.socket;
  const sharedInput = (terminalConnection.first.value as RuntimeAckFrame).sharedInput === true;
  const independentViews = (terminalConnection.first.value as RuntimeAckFrame).independentViews === true;
  let settled = false;
  let exitPending = false;
  let ownsInput = true;
  let claimingInput = false;
  let pendingInput: Buffer[] = [];
  let pendingInputBytes = 0;
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
    if (frame.type === "input-owner") {
      ownsInput = frame.active;
      if (ownsInput && claimingInput) {
        claimingInput = false;
        const input = pendingInput;
        pendingInput = [];
        pendingInputBytes = 0;
        for (const bytes of input) terminal.write(bytes);
        if (terminal.writableNeedDrain || control.writableNeedDrain) process.stdin.pause();
        else process.stdin.resume();
      }
      return;
    }
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
  const inputStream = new RuntimeInputStream((bytes, reply) => {
    if (settled || exitPending) return;
    if (reply) {
      if (independentViews) {
        if (!channel?.send({ type: "input", data: bytes.toString("base64") })) onTerminalError();
        if (control.writableNeedDrain) stdin.pause();
        return;
      }
      if (ownsInput && !terminal.write(bytes)) stdin.pause();
      return;
    }
    const command = runtimeInputCommand(bytes.toString("latin1"));
    if (!independentViews && command === "claim-input") {
      claimingInput = !ownsInput;
      channel?.send({ type: "claim-input" });
      return;
    }
    if (sharedInput) {
      for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
        if (!channel?.send({ type: "input", data: bytes.subarray(offset, offset + 32 * 1024).toString("base64") })) {
          onTerminalError();
          return;
        }
      }
      if (control.writableNeedDrain) stdin.pause();
      return;
    }
    if (!ownsInput || claimingInput) {
      pendingInput.push(Buffer.from(bytes));
      pendingInputBytes += bytes.length;
      if (!claimingInput) {
        claimingInput = true;
        if (!channel?.send({ type: "claim-input" })) onTerminalError();
      }
      if (pendingInputBytes >= 64 * 1024) stdin.pause();
      return;
    }
    if (!terminal.write(bytes)) stdin.pause();
  });
  const onInput = (bytes: Buffer): void => inputStream.push(bytes);
  const onTerminalDrain = (): void => {
    if (!settled && !exitPending && !terminal.writableNeedDrain && !control.writableNeedDrain &&
      (!claimingInput || pendingInputBytes < 64 * 1024)) stdin.resume();
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
    inputStream.observeOutput(bytes);
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
    control.on("drain", onTerminalDrain);
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
      inputStream.observeOutput(terminalConnection.first.rest);
      const writable = terminalConnection.first.rest.length === 0 ||
        writeOutput(altScreen, terminalConnection.first.rest);
      if (writable) terminal.resume();
      sendResize();
    }
    return await outcome;
  } finally {
    settled = true;
    channel?.dispose();
    inputStream.dispose();
    if (controlCloseTimer) clearTimeout(controlCloseTimer);
    control.off("close", onControlClose);
    control.off("drain", onTerminalDrain);
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
      let outcome: AttachOutcome;
      try {
        outcome = await attachRuntime(metadata, altScreen, controller.signal, options.ui);
      } catch (error) {
        if (await probeRuntime(metadata)) throw new LiveRuntimeAttachError(metadata.sessionId, error);
        throw error;
      }
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

function runtimeIneligibleReason(options: DurableInteractiveOptions): string | undefined {
  if (process.env[RUNTIME_CHILD_ENV] === "1" || process.env[RUNTIME_HOST_ENV] !== undefined) {
    return "the runtime connection is not available in this child process; reconnect with clai --resume";
  }
  if (process.env[RUNTIME_DISABLE_ENV] === "1") {
    return `${RUNTIME_DISABLE_ENV}=1 disables background sessions; unset it and restart clai`;
  }
  if (options.noHistory) return "--no-history disables background sessions; restart without --no-history";
  if (getConfig().privateMode) return "private mode disables background sessions; disable private mode and restart clai";
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return "stdin and stdout must both be interactive terminals; restart clai without input/output redirection";
  }
  return undefined;
}

function runtimeFallbackMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const compact = detail.replace(/\s+/g, " ").trim().slice(0, 300);
  return compact || "unknown runtime error";
}

export async function tryRunDurableInteractive(
  options: DurableInteractiveOptions,
): Promise<boolean> {
  const reason = runtimeIneligibleReason(options);
  setRuntimeDetachUnavailableReason(reason);
  if (reason) return false;
  try {
    const outcome = await runRuntimeClient(options);
    if (outcome.kind === "exit") {
      process.exitCode = outcome.exitCode;
      return true;
    }
    reportDetach(outcome);
    return true;
  } catch (error) {
    if (error instanceof LiveRuntimeAttachError) {
      process.stderr.write(`${error.message}. Reattach with: clai --resume ${error.sessionId}\n`);
      process.exitCode = 1;
      return true;
    }
    const detail = runtimeFallbackMessage(error);
    setRuntimeDetachUnavailableReason(`runtime startup failed (${detail}); resolve the startup error and restart clai`);
    process.stderr.write(
      `Durable session runtime unavailable (${detail}); using foreground mode.\n`,
    );
    return false;
  }
}
