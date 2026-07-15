import type { SessionPlan } from "../../store/plan.js";
import type { AnyAppEvent } from "../events/app-event.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import type { Disposable } from "./disposable.js";

export type PlanListener = () => void;

/**
 * Holds the one current plan entity and keeps it in sync with the event stream
 * (PLAN-003: mutate the existing plan, never append duplicates). Approval and
 * discard mutate persisted status through the persistence port. Observable so
 * the UI can bind reactively without polling (PLAN-002).
 */
export class PlanController implements Disposable {
  private plan: SessionPlan | undefined;
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
    if (event.type === "plan-updated") {
      this.plan = event.payload.plan;
      this.notify();
    }
  }

  /**
   * Load the plan for `sessionId` from disk into memory. Clears the in-memory
   * plan when none is stored (so switching sessions never leaves a stale card).
   */
  async load(sessionId: string): Promise<SessionPlan | undefined> {
    this.plan = await this.persistence.loadPlan(sessionId);
    this.notify();
    return this.plan;
  }

  /** Drop the in-memory plan without touching disk. */
  clear(): void {
    if (!this.plan) return;
    this.plan = undefined;
    this.notify();
  }

  async approve(): Promise<SessionPlan | undefined> {
    if (!this.plan) return undefined;
    const next: SessionPlan = { ...this.plan, status: "approved" };
    this.plan = next;
    await this.persistence.savePlan(next);
    this.notify();
    return next;
  }

  async discard(): Promise<void> {
    if (!this.plan) return;
    const { sessionId } = this.plan;
    this.plan = undefined;
    await this.persistence.deletePlan(sessionId);
    this.notify();
  }

  dispose(): void {
    this.plan = undefined;
    this.listeners.clear();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
