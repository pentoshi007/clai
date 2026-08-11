import type { SessionPlan } from "../../store/plan.js";
import type { AnyAppEvent } from "../events/app-event.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import type { Disposable } from "./disposable.js";

export type PlanListener = () => void;


export class PlanController implements Disposable {
  private plan: SessionPlan | undefined;
  private loadGeneration = 0;
  private activeSessionId: string | undefined;
  private readonly listeners = new Set<PlanListener>();

  constructor(private readonly persistence: PersistencePort) {}

  current(): SessionPlan | undefined {
    return this.plan;
  }

  subscribe(listener: PlanListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  observe(event: AnyAppEvent): void {
    if (event.type === "plan-cleared") {
      if (
        this.activeSessionId &&
        event.payload.planId !== this.activeSessionId
      ) {
        return;
      }
      this.loadGeneration += 1;
      this.plan = undefined;
      this.notify();
      return;
    }
    if (event.type === "plan-updated") {
      const eventSessionId = event.payload.plan.sessionId;
      if (this.activeSessionId && eventSessionId !== this.activeSessionId) {
        return;
      }
      this.activeSessionId ??= eventSessionId;
      // A live event is newer than any in-flight disk projection.
      this.loadGeneration += 1;
      this.plan = event.payload.plan;
      this.notify();
    }
  }

  /**
   * Load the plan for `sessionId` from disk into memory. The previous session's
   * projection is cleared synchronously, and a generation token prevents a
   * slower old-session load from repopulating the controller after /new.
   */
  async load(sessionId: string): Promise<SessionPlan | undefined> {
    this.activeSessionId = sessionId;
    const generation = ++this.loadGeneration;
    this.plan = undefined;
    this.notify();
    const loaded = await this.persistence.loadPlan(sessionId);
    if (generation !== this.loadGeneration) return this.plan;
    this.plan = loaded;
    this.notify();
    return this.plan;
  }

  async refresh(sessionId: string): Promise<SessionPlan | undefined> {
    if (this.activeSessionId && this.activeSessionId !== sessionId) {
      return this.plan;
    }
    this.activeSessionId ??= sessionId;
    const generation = ++this.loadGeneration;
    const loaded = await this.persistence.loadPlan(sessionId);
    if (
      generation !== this.loadGeneration ||
      this.activeSessionId !== sessionId
    ) {
      return this.plan;
    }
    this.plan = loaded;
    this.notify();
    return this.plan;
  }

  /** Drop the in-memory plan without touching disk. */
  clear(): void {
    // Always invalidate pending loads, even when the visible projection is
    // already empty (a late promise must not resurrect it).
    this.loadGeneration += 1;
    const changed = this.plan !== undefined;
    this.plan = undefined;
    if (changed) this.notify();
  }

  async approve(): Promise<SessionPlan | undefined> {
    if (!this.plan) return undefined;
    this.loadGeneration += 1;
    // Approval is a status transition, not a whole-plan replacement —
    // saving the loaded copy could revert a concurrent task/child update.
    if (this.persistence.mutatePlan) {
      const result = await this.persistence.mutatePlan(
        this.plan.sessionId,
        (draft) => {
          if (draft.status === "approved") return false;
          draft.status = "approved";
          return true;
        },
      );
      const next: SessionPlan =
        result.plan ?? { ...this.plan, status: "approved" };
      this.plan = next;
      this.notify();
      return next;
    }
    const next: SessionPlan = { ...this.plan, status: "approved" };
    this.plan = next;
    await this.persistence.savePlan(next);
    this.notify();
    return next;
  }

  async discard(): Promise<void> {
    if (!this.plan) return;
    this.loadGeneration += 1;
    const { sessionId } = this.plan;
    this.plan = undefined;
    await this.persistence.deletePlan(sessionId);
    this.notify();
  }

  dispose(): void {
    this.loadGeneration += 1;
    this.activeSessionId = undefined;
    this.plan = undefined;
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
