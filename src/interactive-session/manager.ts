
import { safeCwd } from "../os/cwd.js";
import { processAlive, processGroupAlive } from "../os/process-tree.js";
import { classifyShellCommand } from "../safety/classifier.js";
import {
  advanceInteractiveEngagementState,
  evaluateInteractiveEngagementInput,
  type InteractiveEngagementState,
} from "../safety/engagement-policy.js";
import type { EngagementScope } from "../store/scope.js";
import { createArtifactWriter } from "./artifact-writer.js";
import {
  clampReadWait,
  resolveDeadline,
  resolveDimensions,
  resolveInteractiveSessionConfig,
  resolveOptionalTimeout,
  resolveQuietInterval,
  type InteractiveSessionConfig,
  type InteractiveSessionOverrides,
} from "./config.js";
import { CleanupCoordinator } from "./cleanup.js";
import {
  ApprovalTokenVault,
  classifyInteractiveInput,
  describeInput,
} from "./input-policy.js";
import { OutputStore, type PageOutcome } from "./output-store.js";
import { RecoveryJournal, hashOwner, type ReconciliationEntry } from "./recovery-journal.js";
import { SessionRegistry } from "./registry.js";
import { systemClock, type Clock, type Unsubscribe } from "./runtime.js";
import { SessionRuntime } from "./session-runtime.js";
import { SessionTelemetry } from "./telemetry.js";
import { defaultTransportFactory } from "./transport-factory.js";
import {
  LaunchFailure,
  encodeTextInput,
  ptyControlBytes,
  pipeControlAction,
  type LaunchIdentity,
  type LaunchRequest,
  type SessionTransportFactory,
} from "./transport.js";
import {
  artifactReference,
  asStableError,
  isTerminalState,
  sessionError,
  SessionErrorException,
  throwSessionError,
  toSummary,
  type ArtifactReceipt,
  type CloseAllResult,
  type CloseOwnerResult,
  type CloseRequest,
  type CloseResult,
  type InteractiveSessionRecord,
  type ListResult,
  type OutputView,
  type ProcessOutcome,
  type ReadRequest,
  type ReadResult,
  type ResizeRequest,
  type ResizeResult,
  type SendRequest,
  type SendResult,
  type SessionInput,
  type SessionOperation,
  type SessionTransportKind,
  type StableError,
  type StartRequest,
  type StartResult,
  type StatusResult,
  type TerminalMode,
  type TerminationReason,
} from "./types.js";

/** Confirmation surface for a `confirm`-level action. Previews are redacted. */
export type ConfirmPreview = (request: {
  readonly title: string;
  readonly description: string;
  readonly reason: string;
}) => Promise<boolean>;

export interface ManagerRequestExtras {
  readonly confirm?: ConfirmPreview | undefined;
  readonly scope?: EngagementScope | undefined;
}

export interface InteractiveSessionManagerDeps {
  readonly config?: InteractiveSessionOverrides | undefined;
  readonly transports?: SessionTransportFactory | undefined;
  readonly clock?: Clock | undefined;
  readonly journal?: RecoveryJournal | undefined;
  readonly telemetry?: SessionTelemetry | undefined;
  readonly artifactBaseDir?: string | undefined;
}

type GatherStop = "quiet" | "deadline" | "exit" | "cancelled";

interface PendingStart {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  finish(): void;
}

export class InteractiveSessionManager {
  private readonly registry = new SessionRegistry();
  private readonly runtimes = new Map<string, SessionRuntime>();
  private readonly approvals = new ApprovalTokenVault();
  private readonly telemetry: SessionTelemetry;
  private readonly journal: RecoveryJournal;
  private readonly cleanup: CleanupCoordinator;
  private readonly transports: SessionTransportFactory;
  private readonly clock: Clock;
  private readonly baseConfig: InteractiveSessionConfig;
  private readonly artifactBaseDir: string | undefined;
  private readonly ownerCloses = new Map<string, Promise<CloseOwnerResult>>();
  private readonly ownerActivations = new Map<string, Promise<void>>();
  private readonly pendingStarts = new Map<string, Set<PendingStart>>();
  private readonly lateLaunches = new Map<string, Set<Promise<void>>>();

  constructor(deps: InteractiveSessionManagerDeps = {}) {
    this.baseConfig = resolveInteractiveSessionConfig(deps.config ?? {});
    this.transports = deps.transports ?? defaultTransportFactory;
    this.clock = deps.clock ?? systemClock;
    this.telemetry = deps.telemetry ?? new SessionTelemetry();
    this.journal = deps.journal ?? new RecoveryJournal();
    this.artifactBaseDir = deps.artifactBaseDir;
    this.cleanup = new CleanupCoordinator({
      registry: this.registry,
      journal: this.journal,
      onFinalized: (runtime) => {
        this.runtimes.delete(runtime.record.id);
      },
    });
  }

  get config(): InteractiveSessionConfig {
    return this.baseConfig;
  }

  reconcileOrphans(): ReconciliationEntry[] {
    return this.journal.reconcile();
  }

  async ptyCapability(): Promise<{ available: boolean; reason?: string | undefined }> {
    const capability = await this.transports.capability();
    return capability.available
      ? { available: true }
      : { available: false, reason: capability.reason };
  }


  async start(request: StartRequest & ManagerRequestExtras): Promise<StartResult> {
    this.assertOwner(request.ownerId, "start");
    await this.awaitOwnerActivation(request.ownerId);
    const pending = this.registerPendingStart(request.ownerId, request.signal);
    try {
      return await this.startManaged({
        ...request,
        signal: pending.controller.signal,
      });
    } finally {
      pending.finish();
    }
  }

  private async startManaged(
    request: StartRequest & ManagerRequestExtras,
  ): Promise<StartResult> {
    const startedAt = Date.now();
    const config = this.baseConfig;
    this.assertOwner(request.ownerId, "start");
    this.assertEnabled(config, "start");
    this.throwIfCancelled(request.signal, "start");
    if (typeof request.command !== "string" || request.command.trim().length === 0) {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation: "start",
        message: "A non-empty command is required to start an interactive session.",
        details: { field: "command" },
      });
    }

    const deadlineMs = resolveDeadline("startDeadlineMs", request.deadlineMs, config, "start");
    const idleTimeoutMs = resolveOptionalTimeout(
      "idleTimeoutMs",
      request.idleTimeoutMs,
      config,
      "start",
    );
    const lifetimeTimeoutMs = resolveOptionalTimeout(
      "lifetimeTimeoutMs",
      request.lifetimeTimeoutMs,
      config,
      "start",
    );
    const mode: TerminalMode = request.terminalMode ?? "preferred";
    if (mode !== "required" && mode !== "preferred" && mode !== "pipe") {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation: "start",
        message: "terminalMode must be required, preferred, or pipe.",
        details: { field: "terminalMode" },
      });
    }
    const dimensions = resolveDimensions(request.columns, request.rows, "start");

    await this.authorizeCommand(request.command, request, config);
    this.throwIfCancelled(request.signal, "start");

    const capability = mode === "pipe" ? undefined : await this.transports.capability();
    this.throwIfCancelled(request.signal, "start");
    let transportKind: SessionTransportKind = "pipe";
    let degraded: "PTY_UNAVAILABLE" | undefined;
    if (mode === "required") {
      if (!capability?.available) {
        throwSessionError({
          code: "PTY_UNAVAILABLE",
          operation: "start",
          message:
            capability?.reason ??
            "A pseudoterminal is required but unavailable on this target.",
          details: { terminalMode: mode },
        });
      }
      transportKind = "pty";
    } else if (mode === "preferred") {
      if (capability?.available) transportKind = "pty";
      else degraded = "PTY_UNAVAILABLE";
    }

    const cwd = request.cwd ?? safeCwd();
    const reservation = await this.registry.withOwnerLock(request.ownerId, async () => {
      this.assertNotFenced(request.ownerId, "start");
      const live = this.registry.liveCount(request.ownerId);
      if (live >= config.liveSessionLimit) {
        throwSessionError({
          code: "LIMIT_REACHED",
          operation: "start",
          message: `This conversation already owns ${live} live interactive sessions.`,
          details: { liveSessions: live, limit: config.liveSessionLimit },
        });
      }
      this.throwIfCancelled(request.signal, "start");
      const id = this.registry.mintId();
      const artifact = await createArtifactWriter({
        sessionId: id,
        captureBytes: config.artifactCaptureBytes,
        chunkBytes: config.artifactChunkBytes,
        persistenceQueueBytes: config.persistenceQueueBytes,
        onLimit: config.onOutputLimit,
        baseDir: this.artifactBaseDir,
      });
      const record: InteractiveSessionRecord = {
        id,
        ownerId: request.ownerId,
        state: "starting",
        transport: transportKind,
        startedAt,
        lastActivityAt: startedAt,
        ...(transportKind === "pty" ? { dimensions } : {}),
        ...(degraded ? { degradedReason: degraded } : {}),
        artifact: artifact.receipt() as ArtifactReceipt,
        earliestCursor: 0,
        latestCursor: 0,
        inputClosed: false,
      };
      this.registry.insert(record);
      this.journal.upsert({
        id,
        ownerHash: hashOwner(request.ownerId),
        pid: undefined,
        processGroupId: undefined,
        identity: undefined,
        platform: process.platform,
        startedAt,
        artifactPath: artifact.path,
        launchConfirmed: false,
      });
      return { record, artifact };
    });

    const { record, artifact } = reservation;
    let retried = false;
    let launchedTransport: SessionRuntime["transport"] | undefined;
    let launchIdentityPersisted = false;
    const persistLaunchIdentity = (identity: LaunchIdentity): void => {
      const persisted = this.journal.upsertDurable({
        id: record.id,
        ownerHash: hashOwner(request.ownerId),
        pid: identity.pid,
        processGroupId: identity.processGroupId,
        identity: identity.identity,
        platform: process.platform,
        startedAt,
        artifactPath: artifact.path,
        launchConfirmed: true,
      });
      if (!persisted) {
        throw new LaunchFailure(
          "JOURNAL_PERSIST_FAILED",
          "Interactive session launch identity could not be persisted.",
          true,
          false,
        );
      }
      launchIdentityPersisted = true;
    };
    try {
      const launchDeadlineMs = Math.max(
        0,
        deadlineMs - (Date.now() - startedAt),
      );
      if (launchDeadlineMs === 0) {
        throw new LaunchFailure(
          "START_DEADLINE",
          "The interactive session did not start before its deadline.",
          false,
          false,
        );
      }
      const launch = await this.launchWithDeadline(
        { command: request.command, cwd, onLaunchIdentity: persistLaunchIdentity },
        transportKind,
        dimensions,
        launchDeadlineMs,
        (didRetry) => {
          retried = didRetry;
        },
        mode === "preferred",
        () => {
          transportKind = "pipe";
          degraded = "PTY_UNAVAILABLE";
          record.transport = "pipe";
          record.degradedReason = "PTY_UNAVAILABLE";
          delete record.dimensions;
        },
        request.signal,
        request.ownerId,
        async (transport) => {
          if (!launchIdentityPersisted) {
            persistLaunchIdentity({
              pid: transport.pid,
              processGroupId: transport.processGroupId,
              identity: transport.identity,
            });
          }
          const cleaned = await this.releaseUnmanagedTransport(transport);
          if (cleaned) this.journal.remove(record.id);
        },
      );
      launchedTransport = launch.transport;
      if (!launchIdentityPersisted) {
        persistLaunchIdentity({
          pid: launchedTransport.pid,
          processGroupId: launchedTransport.processGroupId,
          identity: launchedTransport.identity,
        });
      }
      this.throwIfCancelled(request.signal, "start", record.id);
      const transport = launchedTransport;
      const output = new OutputStore({
        memoryWindowBytes: config.memoryWindowBytes,
        pageBytes: config.pageBytes,
        redactionOverlapBytes: config.redactionOverlapBytes,
        sink: artifact,
        onPause: () => transport.pauseOutput(),
        onResume: () => transport.resumeOutput(),
        onPersistenceStop: (reason) => {
          void this.finalize(
            record.id,
            reason === "output-limit" ? "output-limit" : "explicit-close",
          );
        },
      });
      const runtime = new SessionRuntime({
        record,
        transport,
        output,
        artifact,
        config,
        clock: this.clock,
        idleTimeoutMs,
        lifetimeTimeoutMs,
        engagementState: advanceInteractiveEngagementState({}, request.command),
        onTimeout: (reason) => {
          void this.finalize(record.id, reason);
        },
      });
      runtime.track(
        transport.onOutput((event) => {
          output.ingest(event.stream, event.bytes, event.observedAt);
          runtime.syncCursors();
          runtime.touch();
        }),
      );
      runtime.track(
        transport.onExit((outcome: ProcessOutcome) => {
          runtime.processExited = true;
          this.registry.enrich(record, { processOutcome: outcome });
          runtime.exitSignal.bump();
          void this.finalize(record.id, "process-exit");
        }),
      );
      this.runtimes.set(record.id, runtime);
      this.registry.transition(record, "running");
      this.telemetry.record({
        operation: "start",
        sessionId: record.id,
        durationMs: Date.now() - startedAt,
        result: "ok",
        state: record.state,
        transport: transportKind,
        retryCount: retried ? 1 : 0,
      });
      return {
        operation: "start",
        sessionId: record.id,
        state: record.state,
        transport: transportKind,
        ...(record.dimensions ? { dimensions: record.dimensions } : {}),
        ...(degraded ? { degradedReason: degraded } : {}),
        cursor: output.latestCursor,
        artifact: artifactReference(record.artifact),
        ...(retried ? { retriedLaunch: true } : {}),
      };
    } catch (error) {
      let cleanupVerified = !launchIdentityPersisted;
      if (launchedTransport && !this.runtimes.has(record.id)) {
        cleanupVerified = await this.releaseUnmanagedTransport(launchedTransport);
      }
      try {
        await artifact.close();
      } catch {
        cleanupVerified = false;
      }
      if (cleanupVerified) this.journal.remove(record.id);
      this.registry.transition(record, "failed", {
        terminationReason: "launch-failure",
        cleanupVerified,
        now: Date.now(),
      });
      const stable = this.launchError(error, record.id, retried);
      this.telemetry.record({
        operation: "start",
        sessionId: record.id,
        durationMs: Date.now() - startedAt,
        result: stable.code,
        state: record.state,
        transport: transportKind,
        retryCount: retried ? 1 : 0,
        cleanupVerified,
      });
      throw new SessionErrorException(stable);
    }
  }

  private launchError(
    error: unknown,
    sessionId: string,
    retried: boolean,
  ): StableError {
    if (error instanceof LaunchFailure) {
      const code =
        error.code === "PTY_UNAVAILABLE"
          ? "PTY_UNAVAILABLE"
          : error.code === "START_DEADLINE"
            ? "DEADLINE_EXCEEDED"
            : error.code === "CANCELLED"
              ? "CANCELLED"
              : "LAUNCH_FAILED";
      return sessionError({
        code,
        operation: "start",
        sessionId,
        message: error.message,
        state: "failed",
        retryable: error.transient && !error.spawnConfirmed && !retried,
      });
    }
    return asStableError(error, {
      code: "LAUNCH_FAILED",
      operation: "start",
      sessionId,
      state: "failed",
      message: "The interactive session process failed to start.",
    });
  }

  private async launchWithDeadline(
    request: LaunchRequest,
    kind: SessionTransportKind,
    dimensions: { columns: number; rows: number },
    deadlineMs: number,
    onRetry: (retried: boolean) => void,
    fallbackToPipe: boolean,
    onFallback: () => void,
    signal: AbortSignal | undefined,
    ownerId: string,
    handleLateTransport: (
      transport: SessionRuntime["transport"],
    ) => Promise<void>,
  ): Promise<{ transport: SessionRuntime["transport"] }> {
    const attempt = async (
      transportKind: SessionTransportKind,
    ): Promise<{ transport: SessionRuntime["transport"] }> =>
      transportKind === "pty"
        ? await this.transports.startPty({ ...request, dimensions })
        : await this.transports.startPipe(request);
    const cancelled = (): LaunchFailure =>
      new LaunchFailure(
        "CANCELLED",
        "The interactive session start was cancelled before launch completed.",
        false,
        false,
      );
    if (signal?.aborted) throw cancelled();

    let deadlineTimer: ReturnType<Clock["setTimeout"]> | undefined;
    let rejectStop: ((error: LaunchFailure) => void) | undefined;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
      deadlineTimer = this.clock.setTimeout(() => {
        reject(
          new LaunchFailure(
            "START_DEADLINE",
            "The interactive session did not start before its deadline.",
            false,
            false,
          ),
        );
      }, deadlineMs);
    });
    const onAbort = (): void => rejectStop?.(cancelled());
    signal?.addEventListener("abort", onAbort, { once: true });

    let transportKind = kind;
    let retried = false;
    try {
      while (true) {
        if (signal?.aborted) throw cancelled();
        const activeAttempt = attempt(transportKind);
        try {
          const result = await Promise.race([activeAttempt, stopped]);
          if (signal?.aborted) {
            await handleLateTransport(result.transport);
            throw cancelled();
          }
          return result;
        } catch (error) {
          const launchStopped =
            error instanceof LaunchFailure &&
            (error.code === "START_DEADLINE" || error.code === "CANCELLED");
          if (launchStopped) {
            const cleanup = activeAttempt.then(
              async ({ transport }) => {
                await handleLateTransport(transport);
              },
              () => undefined,
            );
            this.trackLateLaunch(ownerId, cleanup);
            throw error;
          }
          const safeToRetry =
            error instanceof LaunchFailure && !error.spawnConfirmed;
          if (safeToRetry && error.transient && !retried) {
            retried = true;
            onRetry(true);
            continue;
          }
          if (safeToRetry && fallbackToPipe && transportKind === "pty") {
            transportKind = "pipe";
            retried = true;
            onRetry(true);
            onFallback();
            continue;
          }
          throw error;
        }
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (deadlineTimer) this.clock.clearTimeout(deadlineTimer);
    }
  }


  async send(request: SendRequest & ManagerRequestExtras): Promise<SendResult> {
    const startedAt = this.clock.now();
    const runtime = this.requireRuntime(request.ownerId, request.id, "send");
    const config = runtime.config;
    const view: OutputView = request.view ?? "plain";
    const quietMs = resolveQuietInterval(request.quietMs, config, "send");
    const deadlineMs = resolveDeadline("sendDeadlineMs", request.deadlineMs, config, "send");
    const deadlineAt = startedAt + deadlineMs;
    const input = validateInput(request.input, "send");

    this.throwIfCancelled(request.signal, "send", runtime.record.id);
    const { accepted, delivery } = await runtime.policy.run(async () => {
      const engagementState = await this.authorizeInput(runtime, input, request);
      this.throwIfCancelled(request.signal, "send", runtime.record.id);
      if (input.kind === "secret") runtime.output.registerExactSecret(input.value);
      const accepted = await runtime.mutation.run(() => {
        this.throwIfCancelled(request.signal, "send", runtime.record.id);
        return this.accept(runtime, input);
      });
      const delivery = await accepted.settled;
      if (delivery.status !== "not-delivered") {
        runtime.engagementState = engagementState;
      }
      return { accepted, delivery };
    });

    runtime.touch();
    const cursor =
      request.cursor !== undefined ? request.cursor : accepted.cursorAtAcceptance;
    const stop = await this.gather(runtime, quietMs, deadlineAt, request.signal);
    const pageOutcome = runtime.output.page({
      cursor,
      view,
      operation: "send",
      sessionId: runtime.record.id,
    });

    const error = this.sendError(runtime, delivery, stop, pageOutcome);
    this.telemetry.record({
      operation: "send",
      sessionId: runtime.record.id,
      durationMs: this.clock.now() - startedAt,
      result: error?.code ?? "ok",
      state: runtime.record.state,
      transport: runtime.record.transport,
      inputBytes: accepted.queuedBytes,
      outputBytes: pageOutcome.page.nextCursor - pageOutcome.page.requestedCursor,
      queueDepth: runtime.input.depth,
      retryCount: 0,
    });
    return {
      operation: "send",
      sessionId: runtime.record.id,
      inputSequence: accepted.sequence,
      delivery: delivery.status,
      deliveredBytes: delivery.deliveredBytes,
      state: runtime.record.state,
      page: pageOutcome.page,
      ...(error ? { error } : {}),
    };
  }

  private sendError(
    runtime: SessionRuntime,
    delivery: { status: string; deliveredBytes: number },
    stop: GatherStop,
    pageOutcome: PageOutcome,
  ): StableError | undefined {
    const sessionId = runtime.record.id;
    if (delivery.status === "unknown") {
      return sessionError({
        code: "INPUT_DELIVERY_UNKNOWN",
        operation: "send",
        sessionId,
        state: runtime.record.state,
        message:
          "The transport could not confirm whether the input bytes were accepted. Do not resend; read output to determine the effect.",
        details: { deliveredBytes: delivery.deliveredBytes },
      });
    }
    if (delivery.status === "not-delivered") {
      return sessionError({
        code: "SESSION_NOT_RUNNING",
        operation: "send",
        sessionId,
        state: runtime.record.state,
        message: "The session was no longer accepting input when the write ran.",
        details: { deliveredBytes: 0 },
      });
    }
    if (stop === "cancelled") {
      return sessionError({
        code: "CANCELLED",
        operation: "send",
        sessionId,
        state: runtime.record.state,
        message:
          "Output gathering was cancelled after the input was delivered; the session is still available.",
      });
    }
    if (stop === "deadline") {
      return sessionError({
        code: "DEADLINE_EXCEEDED",
        operation: "send",
        sessionId,
        state: runtime.record.state,
        message:
          "The send deadline elapsed after input delivery. Continue with a read from nextCursor; do not resend the input.",
      });
    }
    return pageOutcome.ok ? undefined : pageOutcome.error;
  }

  private accept(
    runtime: SessionRuntime,
    input: SessionInput,
  ): {
    sequence: number;
    queuedBytes: number;
    cursorAtAcceptance: number;
    settled: Promise<{ status: "delivered" | "not-delivered" | "unknown"; deliveredBytes: number }>;
  } {
    const record = runtime.record;
    if (record.state === "closing") {
      throwSessionError({
        code: "SESSION_CLOSING",
        operation: "send",
        sessionId: record.id,
        state: record.state,
        message: "This session is closing and no longer accepts input.",
      });
    }
    if (record.state !== "running") {
      throwSessionError({
        code: "SESSION_NOT_RUNNING",
        operation: "send",
        sessionId: record.id,
        state: record.state,
        message: "This session is not running.",
      });
    }
    if (record.inputClosed) {
      throwSessionError({
        code: "INPUT_CLOSED",
        operation: "send",
        sessionId: record.id,
        state: record.state,
        message: "Session input was closed by a prior EOF; no further input is accepted.",
      });
    }
    if (input.kind === "control") this.assertControlSupported(runtime, input.control);

    const bytes =
      input.kind === "text" || input.kind === "secret"
        ? encodeTextInput(
            input.kind === "text" ? input.text : input.value,
            input.submit,
            runtime.transport.kind,
          )
        : new Uint8Array(0);
    const queuedBytes = bytes.length;
    const pending = runtime.input.pendingBytes;
    if (pending + queuedBytes > runtime.config.queuedInputBytes) {
      throwSessionError({
        code: "BACKPRESSURE",
        operation: "send",
        sessionId: record.id,
        state: record.state,
        message: "Queued input for this session would exceed its backpressure limit.",
        details: {
          queuedBytes: pending,
          limitBytes: runtime.config.queuedInputBytes,
        },
      });
    }

    if (input.kind === "eof") record.inputClosed = true;
    const sequence = runtime.input.reserve(queuedBytes);
    const cursorAtAcceptance = runtime.output.latestCursor;
    let settle: (value: {
      status: "delivered" | "not-delivered" | "unknown";
      deliveredBytes: number;
    }) => void = () => undefined;
    const settled = new Promise<{
      status: "delivered" | "not-delivered" | "unknown";
      deliveredBytes: number;
    }>((resolve) => {
      settle = resolve;
    });
    runtime.input.enqueue({
      sequence,
      queuedBytes,
      cursorAtAcceptance,
      deliver: async () => {
        if (input.kind === "eof") return await runtime.transport.closeInput();
        if (input.kind === "control") return await runtime.transport.control(input.control);
        return await runtime.transport.write(bytes);
      },
      settle: (outcome) =>
        settle({ status: outcome.status, deliveredBytes: outcome.deliveredBytes }),
    });
    runtime.touch();
    return { sequence, queuedBytes, cursorAtAcceptance, settled };
  }

  private assertControlSupported(runtime: SessionRuntime, control: string): void {
    const supported =
      runtime.transport.kind === "pty"
        ? ptyControlBytes(control as never) !== undefined
        : pipeControlAction(control as never).kind !== "unsupported";
    if (supported) return;
    throwSessionError({
      code: "UNSUPPORTED_CONTROL",
      operation: "send",
      sessionId: runtime.record.id,
      state: runtime.record.state,
      message: "That control is not supported by this transport on this platform.",
      details: { control, transport: runtime.transport.kind },
    });
  }

  private gather(
    runtime: SessionRuntime,
    quietMs: number,
    deadlineAt: number,
    signal: AbortSignal | undefined,
  ): Promise<GatherStop> {
    if (runtime.processExited) return Promise.resolve<GatherStop>("exit");
    if (signal?.aborted) return Promise.resolve<GatherStop>("cancelled");
    return new Promise<GatherStop>((resolve) => {
      const cleanups: Unsubscribe[] = [];
      let quietTimer = this.clock.setTimeout(() => finish("quiet"), quietMs);
      const deadlineTimer = this.clock.setTimeout(
        () => finish("deadline"),
        Math.max(0, deadlineAt - this.clock.now()),
      );
      let settled = false;
      const finish = (stop: GatherStop): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(quietTimer);
        this.clock.clearTimeout(deadlineTimer);
        for (const cleanup of cleanups) cleanup();
        signal?.removeEventListener("abort", onAbort);
        resolve(stop);
      };
      const onAbort = (): void => finish("cancelled");
      cleanups.push(
        runtime.output.subscribe(() => {
          if (settled) return;
          this.clock.clearTimeout(quietTimer);
          quietTimer = this.clock.setTimeout(() => finish("quiet"), quietMs);
        }),
      );
      cleanups.push(runtime.exitSignal.subscribe(() => finish("exit")));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }


  async read(request: ReadRequest): Promise<ReadResult> {
    const startedAt = Date.now();
    const runtime = this.requireRuntime(request.ownerId, request.id, "read");
    const view: OutputView = request.view ?? "plain";
    if (!Number.isInteger(request.cursor) || request.cursor < 0) {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation: "read",
        sessionId: request.id,
        message: "read requires a non-negative integer cursor.",
        details: { field: "cursor" },
      });
    }
    const waitMs = clampReadWait(request.waitMs);
    let stop: GatherStop = "quiet";
    if (waitMs > 0 && request.cursor >= runtime.output.latestCursor) {
      stop = await this.waitForOutput(runtime, request.cursor, waitMs, request.signal);
    }
    const pageOutcome = runtime.output.page({
      cursor: request.cursor,
      view,
      operation: "read",
      sessionId: runtime.record.id,
    });
    const error =
      stop === "cancelled"
        ? sessionError({
            code: "CANCELLED",
            operation: "read",
            sessionId: runtime.record.id,
            state: runtime.record.state,
            message: "The blocking read was cancelled; the session is still available.",
          })
        : pageOutcome.ok
          ? undefined
          : pageOutcome.error;
    this.telemetry.record({
      operation: "read",
      sessionId: runtime.record.id,
      durationMs: Date.now() - startedAt,
      result: error?.code ?? "ok",
      state: runtime.record.state,
      transport: runtime.record.transport,
      outputBytes: pageOutcome.page.nextCursor - pageOutcome.page.requestedCursor,
    });
    return {
      operation: "read",
      sessionId: runtime.record.id,
      state: runtime.record.state,
      page: pageOutcome.page,
      ...(error ? { error } : {}),
    };
  }

  private waitForOutput(
    runtime: SessionRuntime,
    cursor: number,
    waitMs: number,
    signal: AbortSignal | undefined,
  ): Promise<GatherStop> {
    if (signal?.aborted) return Promise.resolve<GatherStop>("cancelled");
    return new Promise<GatherStop>((resolve) => {
      const cleanups: Unsubscribe[] = [];
      let settled = false;
      const timer = this.clock.setTimeout(() => finish("deadline"), waitMs);
      const finish = (stop: GatherStop): void => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        for (const cleanup of cleanups) cleanup();
        signal?.removeEventListener("abort", onAbort);
        resolve(stop);
      };
      const onAbort = (): void => finish("cancelled");
      cleanups.push(
        runtime.output.subscribe(() => {
          if (runtime.output.latestCursor > cursor) finish("quiet");
        }),
      );
      cleanups.push(runtime.exitSignal.subscribe(() => finish("exit")));
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }


  status(request: { ownerId: string; id: string }): StatusResult {
    this.assertOwner(request.ownerId, "status");
    const record = this.registry.get(request.ownerId, request.id);
    if (!record) this.notFound(request.id, "status");
    return { operation: "status", session: toSummary(record) };
  }

  list(request: { ownerId: string }): ListResult {
    this.assertOwner(request.ownerId, "list");
    return { operation: "list", sessions: this.registry.list(request.ownerId) };
  }

  async resize(request: ResizeRequest): Promise<ResizeResult> {
    const startedAt = Date.now();
    this.assertOwner(request.ownerId, "resize");
    const dimensions = resolveDimensions(request.columns, request.rows, "resize");
    const runtime = this.requireRuntime(request.ownerId, request.id, "resize");
    if (runtime.transport.kind !== "pty" || !runtime.transport.resize) {
      throwSessionError({
        code: "UNSUPPORTED_OPERATION",
        operation: "resize",
        sessionId: request.id,
        state: runtime.record.state,
        message: "Resize requires a pseudoterminal session.",
        details: { transport: runtime.transport.kind },
      });
    }
    const result = await runtime.mutation.run(async () => {
      const record = runtime.record;
      if (record.state !== "running") {
        throwSessionError({
          code: record.state === "closing" ? "SESSION_CLOSING" : "SESSION_NOT_RUNNING",
          operation: "resize",
          sessionId: record.id,
          state: record.state,
          message: "The session is no longer running, so it cannot be resized.",
        });
      }
      await runtime.transport.resize!(dimensions);
      record.dimensions = dimensions;
      return dimensions;
    });
    this.telemetry.record({
      operation: "resize",
      sessionId: request.id,
      durationMs: Date.now() - startedAt,
      result: "ok",
      state: runtime.record.state,
      transport: runtime.record.transport,
    });
    return {
      operation: "resize",
      sessionId: request.id,
      state: runtime.record.state,
      dimensions: result,
    };
  }


  async close(request: CloseRequest): Promise<CloseResult> {
    const startedAt = Date.now();
    this.assertOwner(request.ownerId, "close");
    const record = this.registry.get(request.ownerId, request.id);
    if (!record) this.notFound(request.id, "close");
    const deadlineMs = resolveDeadline(
      "closeDeadlineMs",
      request.deadlineMs,
      this.baseConfig,
      "close",
    );
    const result = await this.finalizeRecord(record, "explicit-close", deadlineMs);
    this.telemetry.record({
      operation: "close",
      sessionId: record.id,
      durationMs: Date.now() - startedAt,
      result: result.error?.code ?? "ok",
      state: result.state,
      transport: record.transport,
      ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
      cleanupVerified: result.cleanupVerified,
    });
    return result;
  }

  async cancelOwner(ownerId: string): Promise<CloseOwnerResult> {
    return await this.closeOwnerSessions(ownerId, "cancelled");
  }

  beginCloseOwner(
    ownerId: string,
    reason: TerminationReason = "conversation-teardown",
  ): Promise<CloseOwnerResult> {
    this.registry.fenceOwner(ownerId);
    const existing = this.ownerCloses.get(ownerId);
    if (existing) return existing;
    const promise = this.closeOwnerSessions(ownerId, reason).finally(() => {
      this.ownerCloses.delete(ownerId);
    });
    this.ownerCloses.set(ownerId, promise);
    return promise;
  }

  async awaitOwnerClose(ownerId: string): Promise<void> {
    await this.ownerCloses.get(ownerId);
  }

  activateOwner(ownerId: string): Promise<void> {
    this.assertOwner(ownerId, "start");
    const existing = this.ownerActivations.get(ownerId);
    if (existing) return existing;
    let activation: Promise<void>;
    activation = (async () => {
      for (;;) {
        await this.ownerCloses.get(ownerId)?.catch(() => undefined);
        const activated = await this.registry.withOwnerLock(ownerId, () => {
          if (this.ownerCloses.has(ownerId)) return false;
          this.registry.unfenceOwner(ownerId);
          return true;
        });
        if (activated) return;
      }
    })().finally(() => {
      if (this.ownerActivations.get(ownerId) === activation) {
        this.ownerActivations.delete(ownerId);
      }
    });
    this.ownerActivations.set(ownerId, activation);
    return activation;
  }

  private async awaitOwnerActivation(ownerId: string): Promise<void> {
    await this.ownerActivations.get(ownerId);
  }

  async closeAll(reason: TerminationReason = "app-shutdown"): Promise<CloseAllResult> {
    const owners = [
      ...new Set([
        ...this.registry.owners(),
        ...this.pendingStarts.keys(),
        ...this.lateLaunches.keys(),
      ]),
    ];
    await Promise.all([...this.ownerCloses.values()].map((promise) => promise.catch(() => undefined)));
    const results = await Promise.all(
      owners.map((ownerId) => this.closeOwnerSessions(ownerId, reason)),
    );
    return {
      owners: owners.length,
      closed: results.reduce((sum, result) => sum + result.closed, 0),
      failures: results.flatMap((result) => result.failures),
    };
  }

  private async closeOwnerSessions(
    ownerId: string,
    reason: TerminationReason,
  ): Promise<CloseOwnerResult> {
    await this.cancelPendingStarts(ownerId);
    const records = this.registry.liveRecords(ownerId);
    const results = await Promise.all(
      records.map((record) =>
        this.finalizeRecord(record, reason, this.baseConfig.closeDeadlineMs),
      ),
    );
    return {
      closed: results.length,
      failures: results
        .map((result) => result.error)
        .filter((error): error is StableError => error !== undefined),
    };
  }

  private async finalizeRecord(
    record: InteractiveSessionRecord,
    reason: TerminationReason,
    deadlineMs: number,
  ): Promise<CloseResult> {
    const runtime = this.runtimes.get(record.id);
    if (!runtime) {
      return {
        operation: "close",
        sessionId: record.id,
        state: record.state,
        ...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
        ...(record.processOutcome ? { processOutcome: record.processOutcome } : {}),
        cleanupVerified: record.cleanupVerified ?? isTerminalState(record.state),
        artifact: artifactReference(record.artifact),
      };
    }
    return await this.cleanup.close(runtime, reason, deadlineMs);
  }

  private async finalize(id: string, reason: TerminationReason): Promise<void> {
    const record = this.registry.getUnscoped(id);
    if (!record) return;
    await this.finalizeRecord(record, reason, this.baseConfig.closeDeadlineMs);
  }


  private async authorizeCommand(
    command: string,
    request: ManagerRequestExtras,
    config: InteractiveSessionConfig,
  ): Promise<void> {
    void config;
    const decision = classifyShellCommand(
      command,
      request.scope ? { scope: request.scope } : {},
    );
    if (decision.level === "block") {
      throwSessionError({
        code: "INPUT_REJECTED",
        operation: "start",
        message: `Blocked by safety policy: ${decision.reason}.`,
      });
    }
    if (decision.level === "safe") return;
    const approved = await request.confirm?.({
      title: "Start interactive session",
      description: describeInput({ kind: "text", text: command, submit: "enter" }),
      reason: decision.reason,
    });
    if (!approved) {
      throwSessionError({
        code: "INPUT_REJECTED",
        operation: "start",
        message: `Confirmation is required to start this interactive session: ${decision.reason}.`,
      });
    }
  }

  private async authorizeInput(
    runtime: SessionRuntime,
    input: SessionInput,
    request: ManagerRequestExtras,
  ): Promise<InteractiveEngagementState> {
    const engagement =
      input.kind === "text"
        ? evaluateInteractiveEngagementInput(
            request.scope,
            runtime.engagementState,
            input.text,
          )
        : { state: runtime.engagementState, effectful: false };
    if (engagement.decision && !engagement.decision.allowed) {
      throwSessionError({
        code: "INPUT_REJECTED",
        operation: "send",
        sessionId: runtime.record.id,
        state: runtime.record.state,
        message: `Blocked by engagement policy: ${engagement.decision.reason}.`,
      });
    }
    const decision = classifyInteractiveInput({
      ownerId: runtime.record.ownerId,
      sessionId: runtime.record.id,
      transport: runtime.transport.kind,
      input,
      ...(request.scope ? { scope: request.scope } : {}),
    });
    if (decision.level === "safe") return engagement.state;
    if (decision.level === "block") {
      throwSessionError({
        code: "INPUT_REJECTED",
        operation: "send",
        sessionId: runtime.record.id,
        state: runtime.record.state,
        message: `Blocked by interactive input policy: ${decision.reason}.`,
      });
    }
    const binding = {
      ownerId: runtime.record.ownerId,
      sessionId: runtime.record.id,
      input,
      decision: decision.level,
    };
    const approved = await request.confirm?.({
      title: "Send interactive input",
      description: describeInput(input),
      reason: decision.reason,
    });
    const token = approved ? this.approvals.mint(binding) : undefined;
    if (!this.approvals.consume(token, binding)) {
      throwSessionError({
        code: "INPUT_REJECTED",
        operation: "send",
        sessionId: runtime.record.id,
        state: runtime.record.state,
        message: `Confirmation is required for this input: ${decision.reason}.`,
      });
    }
    return engagement.state;
  }


  private registerPendingStart(
    ownerId: string,
    source: AbortSignal | undefined,
  ): PendingStart {
    const controller = new AbortController();
    const forwardAbort = (): void => controller.abort(source?.reason);
    if (source?.aborted) forwardAbort();
    else source?.addEventListener("abort", forwardAbort, { once: true });
    let resolveSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let finished = false;
    let pending: PendingStart;
    pending = {
      controller,
      settled,
      finish: () => {
        if (finished) return;
        finished = true;
        source?.removeEventListener("abort", forwardAbort);
        const starts = this.pendingStarts.get(ownerId);
        starts?.delete(pending);
        if (starts?.size === 0) this.pendingStarts.delete(ownerId);
        resolveSettled();
      },
    };
    const starts = this.pendingStarts.get(ownerId) ?? new Set<PendingStart>();
    starts.add(pending);
    this.pendingStarts.set(ownerId, starts);
    return pending;
  }

  private trackLateLaunch(ownerId: string, cleanup: Promise<void>): void {
    const launches = this.lateLaunches.get(ownerId) ?? new Set<Promise<void>>();
    launches.add(cleanup);
    this.lateLaunches.set(ownerId, launches);
    void cleanup.finally(() => {
      launches.delete(cleanup);
      if (launches.size === 0) this.lateLaunches.delete(ownerId);
    });
  }

  private async cancelPendingStarts(ownerId: string): Promise<void> {
    for (;;) {
      const starts = [...(this.pendingStarts.get(ownerId) ?? [])];
      if (starts.length === 0) break;
      for (const pending of starts) pending.controller.abort();
      await Promise.all(starts.map((pending) => pending.settled));
    }
    for (;;) {
      const launches = [...(this.lateLaunches.get(ownerId) ?? [])];
      if (launches.length === 0) break;
      await Promise.all(launches.map((launch) => launch.catch(() => undefined)));
    }
  }

  private async releaseUnmanagedTransport(
    transport: SessionRuntime["transport"],
  ): Promise<boolean> {
    let verified = true;
    try {
      const outcome = await transport.requestTreeTermination("forceful");
      if (outcome === "failed") verified = false;
    } catch {
      verified = false;
    }
    const deadline = Date.now() + Math.min(this.baseConfig.closeDeadlineMs, 2_000);
    while (
      Date.now() < deadline &&
      (processAlive(transport.pid) || processGroupAlive(transport.processGroupId))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (processAlive(transport.pid) || processGroupAlive(transport.processGroupId)) {
      verified = false;
    }
    try {
      await transport.dispose();
    } catch {
      verified = false;
    }
    return verified;
  }

  private throwIfCancelled(
    signal: AbortSignal | undefined,
    operation: SessionOperation,
    sessionId?: string,
  ): void {
    if (!signal?.aborted) return;
    throwSessionError({
      code: "CANCELLED",
      operation,
      ...(sessionId ? { sessionId } : {}),
      message: `The interactive session ${operation} was cancelled before it took effect.`,
    });
  }

  private assertOwner(ownerId: string | undefined, operation: SessionOperation): void {
    if (typeof ownerId === "string" && ownerId.length > 0) return;
    throwSessionError({
      code: "INVALID_REQUEST",
      operation,
      message: "An owning conversation id is required for interactive session operations.",
      details: { field: "ownerId" },
    });
  }

  private assertNotFenced(ownerId: string, operation: SessionOperation): void {
    if (!this.registry.isFenced(ownerId)) return;
    throwSessionError({
      code: "SESSION_CLOSING",
      operation,
      message: "This conversation is being torn down and cannot own new sessions.",
    });
  }

  private assertEnabled(
    config: InteractiveSessionConfig,
    operation: SessionOperation,
  ): void {
    if (config.enabled) return;
    throwSessionError({
      code: "UNSUPPORTED_OPERATION",
      operation,
      message: "Interactive terminal sessions are disabled in this configuration.",
    });
  }

  private notFound(id: string, operation: SessionOperation): never {
    throwSessionError({
      code: "SESSION_NOT_FOUND",
      operation,
      sessionId: id,
      message: "No interactive session with that id is owned by this conversation.",
    });
  }

  private requireRuntime(
    ownerId: string,
    id: string,
    operation: SessionOperation,
  ): SessionRuntime {
    this.assertOwner(ownerId, operation);
    const record = this.registry.get(ownerId, id);
    if (!record) this.notFound(id, operation);
    const runtime = this.runtimes.get(id);
    if (!runtime) {
      throwSessionError({
        code: "SESSION_NOT_RUNNING",
        operation,
        sessionId: id,
        state: record.state,
        message: "This session has already reached a terminal state.",
      });
    }
    return runtime;
  }
}

export function validateInput(
  input: SessionInput | undefined,
  operation: SessionOperation,
): SessionInput {
  if (!input) {
    throwSessionError({
      code: "INVALID_REQUEST",
      operation,
      message: "An input action is required.",
      details: { field: "kind" },
    });
  }
  if (input.kind === "text") {
    if (typeof input.text !== "string") {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation,
        message: "Text input requires a string body.",
        details: { field: "text" },
      });
    }
    if (input.submit !== "enter" && input.submit !== "none") {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation,
        message: "Text input requires submit to be enter or none.",
        details: { field: "submit" },
      });
    }
    return input;
  }
  if (input.kind === "secret") {
    if (typeof input.value !== "string") {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation,
        message: "Secret input requires a string value.",
        details: { field: "value" },
      });
    }
    if (input.submit !== "enter" && input.submit !== "none") {
      throwSessionError({
        code: "INVALID_REQUEST",
        operation,
        message: "Secret input requires submit to be enter or none.",
        details: { field: "submit" },
      });
    }
    return input;
  }
  if (input.kind === "control" || input.kind === "eof") return input;
  throwSessionError({
    code: "INVALID_REQUEST",
    operation,
    message: "Input kind must be text, secret, control, or eof.",
    details: { field: "kind" },
  });
}

export const interactiveSessionManager = new InteractiveSessionManager();
try {
  interactiveSessionManager.reconcileOrphans();
} catch {
  void 0;
}
