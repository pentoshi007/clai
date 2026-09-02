
import {
  processIdentityTracker,
  type ProcessIdentityComparison,
} from "../os/process-identity.js";
import {
  hasLiveDescendants,
  processAlive,
  processGroupAlive,
} from "../os/process-tree.js";
import type { RecoveryJournal } from "./recovery-journal.js";
import type { SessionRegistry } from "./registry.js";
import type { SessionRuntime } from "./session-runtime.js";
import {
  artifactReference,
  isTerminalState,
  sessionError,
  type CloseResult,
  type SessionState,
  type StableError,
  type TerminationReason,
} from "./types.js";

const POLL_INTERVAL_MS = 50;

export interface CleanupDeps {
  readonly registry: SessionRegistry;
  readonly journal: RecoveryJournal;
  readonly onFinalized?: ((runtime: SessionRuntime) => void) | undefined;
  readonly process?: Partial<CleanupProcessDeps> | undefined;
}

export interface CleanupProcessDeps {
  readonly isAlive: (pid: number | undefined) => boolean;
  readonly isProcessGroupAlive: (processGroupId: number | undefined) => boolean;
  readonly compareIdentity: (
    pid: number | undefined,
    identity: string | undefined,
  ) => ProcessIdentityComparison;
  readonly hasLiveDescendants: (pid: number) => Promise<boolean>;
}

const defaultProcessDeps: CleanupProcessDeps = {
  isAlive: processAlive,
  isProcessGroupAlive: processGroupAlive,
  compareIdentity: (pid, identity) => processIdentityTracker.compare(pid, identity),
  hasLiveDescendants,
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function terminalStateFor(
  reason: TerminationReason,
  processExited: boolean,
  cleanupFailed: boolean,
): SessionState {
  if (cleanupFailed) return "failed";
  if (reason === "process-exit" || processExited) return "exited";
  if (reason === "launch-failure") return "failed";
  return "closed";
}

export class CleanupCoordinator {
  private readonly process: CleanupProcessDeps;

  constructor(private readonly deps: CleanupDeps) {
    this.process = { ...defaultProcessDeps, ...deps.process };
  }

  close(
    runtime: SessionRuntime,
    reason: TerminationReason,
    deadlineMs: number,
  ): Promise<CloseResult> {
    if (isTerminalState(runtime.record.state) && runtime.finalize.started) {
      return runtime.finalize.join()!;
    }
    return runtime.finalize.run(reason, () => this.execute(runtime, reason, deadlineMs));
  }

  private async execute(
    runtime: SessionRuntime,
    reason: TerminationReason,
    deadlineMs: number,
  ): Promise<CloseResult> {
    const record = runtime.record;
    const started = Date.now();
    const remaining = (): number => Math.max(0, deadlineMs - (Date.now() - started));

    this.deps.registry.transition(record, "closing", { terminationReason: reason });

    runtime.input.rejectAll({ status: "not-delivered", deliveredBytes: 0 });

    let error: StableError | undefined;
    let cleanupVerified = true;

    const rootAlive = this.process.isAlive(runtime.transport.pid);
    const groupAlive = this.process.isProcessGroupAlive(
      runtime.transport.processGroupId,
    );
    let canSignal = false;
    let verifyGroup = runtime.transport.processGroupId !== undefined;
    if (rootAlive) {
      const identity = this.process.compareIdentity(
        runtime.transport.pid,
        runtime.transport.identity,
      );
      if (identity === "match") {
        canSignal = true;
      } else if (identity === "unknown") {
        cleanupVerified = false;
        error = sessionError({
          code: "CLEANUP_FAILED",
          operation: "close",
          sessionId: record.id,
          message: "Process ownership could not be verified during cleanup.",
          details: { reason: "identity-unverified" },
        });
      }
    } else if (groupAlive && runtime.transport.processGroupId !== undefined) {
      canSignal = true;
      verifyGroup = true;
    } else if (groupAlive) {
      cleanupVerified = false;
      error = sessionError({
        code: "CLEANUP_FAILED",
        operation: "close",
        sessionId: record.id,
        message: "A live process group could not be safely signalled during cleanup.",
        details: { reason: "group-unverified" },
      });
    }

    if (canSignal && (rootAlive || groupAlive)) {
      await runtime.transport.requestTreeTermination("graceful");
      const graceMs = Math.min(runtime.config.gracefulCloseMs, remaining());
      await this.waitForTreeExit(runtime, graceMs);
      if (
        this.process.isAlive(runtime.transport.pid) ||
        this.process.isProcessGroupAlive(runtime.transport.processGroupId)
      ) {
        await runtime.transport.requestTreeTermination("forceful");
        await this.waitForTreeExit(runtime, remaining());
      }
    }

    await this.waitForOutputDrain(runtime, remaining());

    runtime.output.finish();
    runtime.syncCursors();
    try {
      await runtime.artifact.close();
    } catch {
      error ??= sessionError({
        code: "PERSIST_FAILED",
        operation: "close",
        sessionId: record.id,
        message: "Session output artifact could not be flushed during cleanup.",
        details: { artifactPath: runtime.artifact.path },
      });
    }

    const survivors = await this.verifyAbsence(runtime, remaining(), verifyGroup);
    if (survivors) {
      cleanupVerified = false;
      error ??= sessionError({
        code: "CLEANUP_FAILED",
        operation: "close",
        sessionId: record.id,
        message:
          "A descendant of this interactive session was still alive after the close deadline.",
        details: { survivingDescendants: 1, elapsedMs: Date.now() - started },
      });
    }

    runtime.timers.clearAll();
    runtime.releaseListeners();
    await runtime.transport.dispose();
    runtime.output.dispose();
    runtime.disposed = true;
    if (cleanupVerified) this.deps.journal.remove(record.id);

    record.artifact = runtime.artifact.receipt();
    const state = terminalStateFor(reason, runtime.processExited, error !== undefined);
    this.deps.registry.transition(record, state, {
      terminationReason: reason,
      ...(record.processOutcome ? { processOutcome: record.processOutcome } : {}),
      cleanupVerified,
      now: Date.now(),
    });
    this.deps.onFinalized?.(runtime);

    return {
      operation: "close",
      sessionId: record.id,
      state: record.state,
      ...(record.terminationReason ? { terminationReason: record.terminationReason } : {}),
      ...(record.processOutcome ? { processOutcome: record.processOutcome } : {}),
      cleanupVerified,
      artifact: artifactReference(record.artifact),
      ...(error ? { error } : {}),
    };
  }

  private async waitForOutputDrain(runtime: SessionRuntime, budgetMs: number): Promise<void> {
    const wait = runtime.transport.waitForOutputDrain;
    if (!wait || budgetMs <= 0) return;
    await Promise.race([wait.call(runtime.transport), delay(budgetMs)]).catch(() => undefined);
  }

  private async waitForTreeExit(
    runtime: SessionRuntime,
    budgetMs: number,
  ): Promise<void> {
    const deadline = Date.now() + Math.max(0, budgetMs);
    while (Date.now() < deadline) {
      if (
        !this.process.isAlive(runtime.transport.pid) &&
        !this.process.isProcessGroupAlive(runtime.transport.processGroupId)
      ) {
        return;
      }
      await delay(POLL_INTERVAL_MS);
    }
  }

  private async verifyAbsence(
    runtime: SessionRuntime,
    budgetMs: number,
    verifyGroup: boolean,
  ): Promise<boolean> {
    const pid = runtime.transport.pid;
    if (pid <= 0) return false;
    if (this.process.isAlive(pid)) {
      const identity = this.process.compareIdentity(pid, runtime.transport.identity);
      if (identity === "match") return true;
    }
    if (
      verifyGroup &&
      this.process.isProcessGroupAlive(runtime.transport.processGroupId)
    ) {
      return true;
    }
    if (budgetMs <= 0) return false;
    return await this.process.hasLiveDescendants(pid);
  }
}
