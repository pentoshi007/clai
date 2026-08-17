import type { ToolResult } from "../../types.js";

export interface CancelWorkSnapshot {
  readonly turn: boolean;
  readonly compaction: boolean;
  readonly queuedPrompts: number;
  readonly responderJobs: number;
  readonly pendingNotifications: number;
  readonly interruptible: boolean;
}

export interface AbortForegroundOutcome {
  readonly turnAborted: boolean;
  readonly interruptibleCancelled: number;
}

export interface CancelAllOutcome {
  readonly ok: boolean;
  readonly turnAborted: boolean;
  readonly compactionAborted: boolean;
  readonly interruptibleCancelled: number;
  readonly sessionResult: ToolResult;
}

export interface CancelCoordinatorSession {
  getState(): {
    readonly running: boolean;
    readonly compacting: boolean;
    readonly queued: readonly string[];
  };
  abort(): void;
  cancelAll(): Promise<ToolResult>;
}

export interface CancelCoordinatorJobs {
  running(sessionId: string): readonly unknown[];
  pendingNotifications(sessionId: string): readonly unknown[];
}

export interface CancelCoordinatorInterruptible {
  hasWork(): boolean;
  cancelAll(): number;
}

export interface CancelCoordinatorDeps {
  readonly session: CancelCoordinatorSession;
  readonly sessionId: () => string;
  readonly jobs: CancelCoordinatorJobs;
  readonly interruptible: CancelCoordinatorInterruptible;
}

export class CancelCoordinator {
  constructor(private readonly deps: CancelCoordinatorDeps) {}

  snapshot(): CancelWorkSnapshot {
    const state = this.deps.session.getState();
    const sessionId = this.deps.sessionId();
    return {
      turn: state.running,
      compaction: state.compacting,
      queuedPrompts: state.queued.length,
      responderJobs: this.deps.jobs.running(sessionId).length,
      pendingNotifications: this.deps.jobs.pendingNotifications(sessionId).length,
      interruptible: this.deps.interruptible.hasWork(),
    };
  }

  hasCancelableWork(): boolean {
    const snap = this.snapshot();
    return (
      snap.turn ||
      snap.compaction ||
      snap.responderJobs > 0 ||
      snap.pendingNotifications > 0 ||
      snap.interruptible
    );
  }

  abortForeground(): AbortForegroundOutcome {
    const turnAborted = this.deps.session.getState().running;
    const interruptibleCancelled = this.deps.interruptible.cancelAll();
    if (turnAborted) this.deps.session.abort();
    return { turnAborted, interruptibleCancelled };
  }

  async cancelAll(): Promise<CancelAllOutcome> {
    const state = this.deps.session.getState();
    const turnAborted = state.running;
    const compactionAborted = state.compacting;
    const interruptibleCancelled = this.deps.interruptible.cancelAll();
    const sessionResult = await this.deps.session.cancelAll();
    return {
      ok: sessionResult.ok,
      turnAborted,
      compactionAborted,
      interruptibleCancelled,
      sessionResult,
    };
  }
}
