import type { SubagentManager } from "../../agent/subagents/manager.js";

interface SessionSubagentsDeps {
  readonly sessionId: () => string;
  readonly isBusy: () => boolean;
  readonly hasQueuedWork: () => boolean;
  readonly continueQueue: () => Promise<void>;
  readonly runTurn: (prompt: string) => Promise<{ readonly status: "completed" | "aborted" | "error" }>;
}

export class SessionSubagents {
  private manager: SubagentManager | undefined;
  private unsubscribe: (() => void) | undefined;
  private active = false;
  private disposed = false;
  private generation = 0;
  private wakeRequested = false;
  private wakeDrain: Promise<void> | undefined;

  constructor(private readonly deps: SessionSubagentsDeps) {}

  bind(manager: SubagentManager): void {
    this.deactivate();
    this.unsubscribe?.();
    this.manager = manager;
    this.unsubscribe = this.disposed ? undefined : manager.subscribe(() => this.scheduleWake());
  }

  activate(): void {
    if (this.disposed) return;
    this.active = true;
    this.scheduleWake();
  }

  deactivate(): void {
    this.active = false;
    this.generation += 1;
    this.wakeRequested = false;
  }

  scheduleWake(): void {
    if (!this.active || this.disposed || !this.manager?.enabled) return;
    this.wakeRequested = true;
    if (this.deps.isBusy() || this.wakeDrain) return;
    const generation = this.generation;
    const drain = Promise.resolve()
      .then(() => this.drainOne(generation))
      .catch(() => {
        if (generation === this.generation) this.wakeRequested = false;
      })
      .finally(() => {
        if (this.wakeDrain !== drain) return;
        this.wakeDrain = undefined;
        if (this.wakeRequested && !this.deps.isBusy()) this.scheduleWake();
      });
    this.wakeDrain = drain;
  }

  private async drainOne(generation: number): Promise<void> {
    const manager = this.manager;
    if (generation !== this.generation || !this.active || !manager?.enabled) return;
    if (this.deps.isBusy()) return;
    this.wakeRequested = false;
    if (manager.parentSessionId !== this.deps.sessionId() || !manager.pendingResults().length) return;
    if (this.deps.hasQueuedWork()) {
      await this.deps.continueQueue();
      return;
    }
    const pending = manager.pendingResults();
    const result = await this.deps.runTurn(
      "Subagent results arrived while the model was idle. Review the delivered read-only evidence, resolve any remaining dependencies, and report the outcome. Do not repeat completed research or stop healthy children.",
    );
    if (generation !== this.generation) return;
    this.wakeRequested = result.status === "completed" && manager.pendingResults().some(
      (run) => !pending.some((previous) => previous.id === run.id && previous.attempt === run.attempt),
    );
  }

  dispose(): void {
    this.deactivate();
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.manager = undefined;
  }
}
