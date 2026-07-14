import type { SessionPlan } from "../../store/plan.js";
import type { AnyAppEvent } from "../events/app-event.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import type { Disposable } from "./disposable.js";

/**
 * Holds the one current plan entity and keeps it in sync with the event stream
 * (PLAN-003: mutate the existing plan, never append duplicates). Approval and
 * discard mutate persisted status through the persistence port.
 */
export class PlanController implements Disposable {
  private plan: SessionPlan | undefined;

  constructor(private readonly persistence: PersistencePort) {}

  current(): SessionPlan | undefined {
    return this.plan;
  }

  observe(event: AnyAppEvent): void {
    if (event.type === "plan-updated") {
      this.plan = event.payload.plan;
    }
  }

  async load(sessionId: string): Promise<SessionPlan | undefined> {
    this.plan = await this.persistence.loadPlan(sessionId);
    return this.plan;
  }

  async approve(): Promise<SessionPlan | undefined> {
    if (!this.plan) return undefined;
    const next: SessionPlan = { ...this.plan, status: "approved" };
    this.plan = next;
    await this.persistence.savePlan(next);
    return next;
  }

  async discard(): Promise<void> {
    if (!this.plan) return;
    const { sessionId } = this.plan;
    this.plan = undefined;
    await this.persistence.deletePlan(sessionId);
  }

  dispose(): void {
    this.plan = undefined;
  }
}
