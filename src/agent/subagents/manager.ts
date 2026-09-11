import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { isValidSubagentParentId, restoreSubagentRun, sanitizeSubagentRun, sanitizeSubagentText, SUBAGENT_LIMITS } from "../../store/subagents.js";
import { subagentReportStatus } from "./report.js";
import type { SubagentAssignment, SubagentCheckpoint, SubagentEvent, SubagentFollowup, SubagentRun, SubagentStore, SubagentWorker } from "./types.js";

type Child = {
  run: SubagentRun;
  assignment: SubagentAssignment;
  assistantSequence?: number | undefined;
  controller?: AbortController | undefined;
  persistenceTimer?: ReturnType<typeof setTimeout> | undefined;
  checkpoint?: SubagentCheckpoint | undefined;
};
type Waiter = { check: () => void; reject: (error: Error) => void };
const terminal = (status: SubagentRun["status"]): boolean => status !== "running" && status !== "stopping";
const defaultWorker: SubagentWorker = async (input) => (await import("./worker.js")).runReadOnlySubagent(input);
const inFlight = new Map<AbortController, string>();
const fingerprint = (assignment: SubagentAssignment): string => createHash("sha256").update(JSON.stringify([assignment.prompt, assignment.context ?? "", assignment.cwd, assignment.provider, assignment.model])).digest("hex");

export class SubagentManager {
  private active = false;
  private disposed = false;
  private readonly children = new Map<string, Child>();
  private readonly listeners = new Set<() => void>();
  private readonly snapshots = new WeakMap<SubagentRun, SubagentRun>();
  private readonly waiters = new Set<Waiter>();
  private readonly results = new Map<string, SubagentRun>();
  private readonly settledAttempts = new Map<string, SubagentRun>();
  private readonly workerContext = new AsyncLocalStorage<boolean>();
  private notificationTimer?: ReturnType<typeof setTimeout> | undefined;
  private readonly worker: SubagentWorker;
  private readonly store: SubagentStore | undefined;

  constructor(readonly parentSessionId: string, options: { worker?: SubagentWorker; store?: SubagentStore } = {}) {
    if (!isValidSubagentParentId(parentSessionId)) throw new Error("Invalid parent session ID");
    this.worker = options.worker ?? defaultWorker;
    this.store = options.store;
    if (this.store) {
      try {
        for (const value of this.store.load(parentSessionId)) {
          const run = restoreSubagentRun(value, parentSessionId);
          if (!run) continue;
          try {
            this.children.set(run.id, { run, assignment: this.assignment(run) });
          } catch {
          }
        }
      } catch {
      }
    }
  }

  get enabled(): boolean {
    return this.active && !this.disposed;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) throw new Error("Subagent manager is disposed");
    if (this.active === enabled) return;
    this.active = enabled;
    if (!enabled) for (const child of this.children.values()) this.stop(child.run.id);
    this.notify(true);
  }

  private assignment(value: SubagentAssignment): SubagentAssignment {
    for (const [name, maximum] of [["title", SUBAGENT_LIMITS.title], ["prompt", SUBAGENT_LIMITS.prompt], ["context", SUBAGENT_LIMITS.context], ["cwd", 4096], ["provider", 128], ["model", 256]] as const) {
      const text = value[name];
      if (name === "context" && (text === undefined || text === "")) continue;
      if (typeof text !== "string" || (name !== "context" && !sanitizeSubagentText(text).trim()) || text.length > maximum) throw new Error(`${name} must be a non-empty string of at most ${maximum} characters`);
    }
    return Object.freeze({ title: value.title, prompt: value.prompt, context: value.context, cwd: value.cwd, provider: value.provider, model: value.model });
  }

  private assertAvailable(): void {
    if (!this.enabled) throw new Error("Subagent orchestration is disabled");
    if (this.workerContext.getStore()) throw new Error("Recursive subagent launches are forbidden");
  }

  private assertUnique(assignment: SubagentAssignment): void {
    if ([...inFlight.values()].includes(fingerprint(assignment))) throw new Error("Duplicate active subagent assignment");
  }

  start(value: SubagentAssignment): SubagentRun {
    this.assertAvailable();
    const assignment = this.assignment(value);
    this.assertUnique(assignment);
    const now = Date.now();
    const child: Child = { assignment, run: { ...assignment, id: randomUUID(), parentSessionId: this.parentSessionId, attempt: 1, status: "running", recovery: "fresh", createdAt: now, updatedAt: now, events: [] } };
    this.children.set(child.run.id, child);
    this.launch(child);
    return this.snapshot(child.run);
  }

  private snapshot(run: SubagentRun): SubagentRun {
    const cached = this.snapshots.get(run);
    if (cached) return cached;
    const snapshot = sanitizeSubagentRun(run);
    this.snapshots.set(run, snapshot);
    this.snapshots.set(snapshot, snapshot);
    return snapshot;
  }

  list(): readonly SubagentRun[] {
    return Object.freeze([...this.children.values()].map((child) => this.snapshot(child.run)));
  }

  get(id: string, attempt?: number): SubagentRun | undefined {
    const child = this.children.get(id);
    if (attempt !== undefined && child?.run.attempt !== attempt) return this.settledAttempts.get(`${id}:${attempt}`);
    return child ? this.snapshot(child.run) : undefined;
  }

  pendingResults(): readonly SubagentRun[] {
    return Object.freeze([...this.results.values()]);
  }

  acknowledgeResult(id: string, attempt: number): void {
    this.results.delete(`${id}:${attempt}`);
  }

  private child(id: string): Child {
    const child = this.children.get(id);
    if (!child) throw new Error("Unknown child ID in this session");
    return child;
  }

  stop(id: string): void {
    const child = this.child(id);
    if (!child.controller || child.run.status !== "running") return;
    child.run = { ...child.run, status: "stopping", updatedAt: Date.now(), report: undefined, error: "Stopped by parent" };
    child.controller.abort(new Error("Stopped by parent"));
    this.changed(child, true);
  }

  restart(id: string, value?: SubagentFollowup): SubagentRun {
    this.assertAvailable();
    const child = this.child(id);
    if (child.controller) throw new Error("Wait for the previous attempt to stop before restarting");
    const followup = this.followup(value);
    this.assertUnique(child.assignment);
    const previous = child.run;
    this.settledAttempts.set(`${previous.id}:${previous.attempt}`, this.snapshot(previous));
    const summary = `Attempt ${previous.attempt}: ${previous.status}\n${previous.report ?? previous.error ?? "No report"}`;
    const events = [...previous.events, { kind: "notice" as const, text: summary, timestamp: Date.now(), sequence: (previous.events.at(-1)?.sequence ?? 0) + 1 }];
    if (followup) events.push({ kind: "notice", text: `Parent follow-up for attempt ${previous.attempt + 1}:\n${JSON.stringify(followup)}`, timestamp: Date.now(), sequence: events.at(-1)!.sequence + 1 });
    if (followup && child.checkpoint) child.checkpoint = { ...child.checkpoint, pendingFollowup: followup };
    child.run = { ...previous, ...child.assignment, followup: followup ? Object.freeze({ ...previous.followup, ...followup }) : previous.followup, attempt: previous.attempt + 1, status: "running", recovery: child.checkpoint ? "exact" : previous.events.length || previous.report ? "history" : "fresh", report: undefined, error: undefined, updatedAt: Date.now(), events: this.boundEvents(events) };
    this.launch(child, followup);
    return this.snapshot(child.run);
  }

  private followup(value?: SubagentFollowup): SubagentFollowup | undefined {
    if (value === undefined) return undefined;
    const result: { prompt?: string; context?: string } = {};
    for (const name of ["prompt", "context"] as const) {
      const text = value[name];
      if (text === undefined) continue;
      const clean = typeof text === "string" ? sanitizeSubagentText(text) : "";
      if (!clean.trim() || text.length > SUBAGENT_LIMITS[name]) throw new Error(`${name} must be a non-empty string of at most ${SUBAGENT_LIMITS[name]} characters`);
      result[name] = clean;
    }
    return Object.keys(result).length ? Object.freeze(result) : undefined;
  }

  private boundEvents(events: readonly SubagentEvent[]): readonly SubagentEvent[] {
    const retained = events.slice(-SUBAGENT_LIMITS.events);
    let total = retained.reduce((sum, event) => sum + event.text.length, 0);
    while (total > SUBAGENT_LIMITS.chars && retained.length > 1) total -= retained.shift()!.text.length;
    return retained.map((event) => ({ ...event, text: event.text.slice(0, SUBAGENT_LIMITS.chars) }));
  }

  private launch(child: Child, followup?: SubagentFollowup): void {
    const controller = new AbortController();
    child.assistantSequence = undefined;
    child.controller = controller;
    inFlight.set(controller, fingerprint(child.assignment));
    const inputRun = this.snapshot(child.run);
    this.changed(child, true);
    const emit: Parameters<SubagentWorker>[0]["emit"] = (event) => {
      if (this.disposed || this.children.get(child.run.id) !== child || child.controller !== controller || controller.signal.aborted) return;
      if (!["assistant", "tool", "notice"].includes(event.kind) || typeof event.text !== "string") throw new Error("Invalid subagent event");
      const events = [...child.run.events];
      const previous = events.at(-1);
      const now = Date.now();
      if (event.kind === "assistant" && event.append && child.assistantSequence !== undefined) {
        const index = events.findIndex((entry) => entry.sequence === child.assistantSequence);
        if (index < 0) return;
        const assistant = events[index]!;
        events[index] = { ...assistant, text: (assistant.text + event.text.slice(0, SUBAGENT_LIMITS.chars)).slice(0, SUBAGENT_LIMITS.chars), timestamp: now };
      } else {
        const sequence = (previous?.sequence ?? 0) + 1;
        events.push({ sequence, kind: event.kind, text: event.text.slice(0, SUBAGENT_LIMITS.chars), timestamp: now });
        if (event.kind === "assistant") child.assistantSequence = sequence;
      }
      child.run = { ...child.run, updatedAt: now, events: this.boundEvents(events) };
      this.changed(child);
    };
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return this.workerContext.run(true, () => this.worker({
        run: inputRun, signal: controller.signal, emit, followup,
        checkpoint: child.checkpoint ? structuredClone(child.checkpoint) : undefined,
        saveCheckpoint: (checkpoint) => {
          if (this.disposed || this.children.get(child.run.id) !== child || child.controller !== controller || controller.signal.aborted) return;
          child.checkpoint = structuredClone(checkpoint);
          if (child.run.recovery !== "exact") {
            child.run = { ...child.run, recovery: "exact" };
            this.changed(child);
          }
        },
      }));
    }).then(
      (report) => this.settle(child, controller, report),
      (error: unknown) => this.settle(child, controller, undefined, error),
    );
  }

  private settle(child: Child, controller: AbortController, report?: string, error?: unknown): void {
    inFlight.delete(controller);
    if (child.controller !== controller) return;
    child.controller = undefined;
    if (this.children.get(child.run.id) !== child) return;
    const stopped = controller.signal.aborted;
    const failed = !stopped && (error !== undefined || typeof report !== "string" || !report.trim());
    const status = typeof report === "string" ? subagentReportStatus(report) : undefined;
    const oversized = typeof report === "string" && Buffer.byteLength(report) > SUBAGENT_LIMITS.report;
    const invalidReport = !failed && typeof report === "string" && /^Status:/i.test(report.trimStart()) && !status;
    try {
      child.run = this.snapshot({
        ...child.run, updatedAt: Date.now(), status: stopped ? "stopped" : failed || invalidReport || oversized ? "error" : status ?? "completed",
        report: stopped || failed || invalidReport || oversized ? undefined : report,
        error: stopped ? "Stopped by parent" : oversized ? "Worker report exceeds the storage safety limit" : invalidReport ? "Worker returned an invalid report" : failed ? sanitizeSubagentText(error instanceof Error ? error.message : error === undefined ? "Worker returned no report" : String(error)).slice(0, 4096) : undefined,
      });
    } catch (failure) {
      child.run = this.snapshot({
        ...child.run, updatedAt: Date.now(), status: "error", report: undefined,
        error: failure instanceof Error ? failure.message : "Worker report could not be retained",
      });
    }
    if (!this.disposed) {
      this.settledAttempts.set(`${child.run.id}:${child.run.attempt}`, this.snapshot(child.run));
      this.results.set(`${child.run.id}:${child.run.attempt}`, this.snapshot(child.run));
      this.changed(child, true);
    }
  }

  async wait(id: string, timeoutMs?: number, signal?: AbortSignal): Promise<SubagentRun> {
    return (await this.waitFor([id], timeoutMs, signal))!;
  }

  async waitAny(ids?: readonly string[], timeoutMs?: number, signal?: AbortSignal): Promise<SubagentRun | undefined> {
    this.assertWait(timeoutMs, signal);
    if (!ids && this.results.size) return this.results.values().next().value;
    return this.waitFor(ids ?? [...this.children.values()].filter((child) => !terminal(child.run.status)).map((child) => child.run.id), timeoutMs, signal);
  }

  private assertWait(timeoutMs?: number, signal?: AbortSignal): void {
    if (this.disposed) throw new Error("Subagent manager is disposed");
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647)) throw new Error("Wait timeout must be an integer between 0 and 2147483647 milliseconds");
    signal?.throwIfAborted();
  }

  private async waitFor(ids: readonly string[], timeoutMs?: number, signal?: AbortSignal): Promise<SubagentRun | undefined> {
    this.assertWait(timeoutMs, signal);
    const runs = ids.map((id) => this.get(id));
    if (runs.some((run) => !run)) throw new Error("Unknown child ID in this session");
    const ready = runs.find((run) => run && terminal(run.status));
    if (ready || timeoutMs === 0 || !runs.length) return ready ?? runs[0];
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.waiters.delete(waiter);
      };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const finish = (): void => {
        const current = ids.map((id) => this.get(id));
        cleanup();
        if (current.some((run) => !run)) reject(new Error("Subagent record was removed"));
        else resolve(current.find((run) => run && terminal(run.status)) ?? current[0]);
      };
      const abort = (): void => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
      const waiter: Waiter = { reject: fail, check: () => {
        if (ids.some((id) => { const run = this.get(id); return !run || terminal(run.status); })) finish();
      } };
      const timer = timeoutMs === undefined ? undefined : setTimeout(finish, timeoutMs);
      this.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  }

  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private checkWaiters(): void {
    for (const waiter of [...this.waiters]) waiter.check();
  }

  private notify(immediate = false): void {
    if (this.disposed) return;
    if (immediate) {
      clearTimeout(this.notificationTimer);
      this.notificationTimer = undefined;
      for (const listener of this.listeners) {
        try { listener(); } catch { }
      }
    } else if (!this.notificationTimer) {
      this.notificationTimer = setTimeout(() => this.notify(true), 100);
      this.notificationTimer.unref();
    }
  }

  private changed(child: Child, immediate = false): void {
    this.checkWaiters();
    if (immediate) this.flush(child);
    else if (this.store && !child.persistenceTimer) {
      child.persistenceTimer = setTimeout(() => this.flush(child), 400);
      child.persistenceTimer.unref();
    }
    this.notify(immediate);
  }

  private flush(child: Child): void {
    clearTimeout(child.persistenceTimer);
    child.persistenceTimer = undefined;
    if (!this.store) return;
    try {
      this.store.save(this.snapshot(child.run));
    } catch (error) {
      const text = `History save failed: ${sanitizeSubagentText(error instanceof Error ? error.message : String(error)).slice(0, 1024)}`;
      if (child.run.events.at(-1)?.text !== text) child.run = { ...child.run, events: this.boundEvents([...child.run.events, { kind: "notice", text, timestamp: Date.now(), sequence: (child.run.events.at(-1)?.sequence ?? 0) + 1 }]) };
      this.notify();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.active = false;
    for (const child of this.children.values()) {
      this.stop(child.run.id);
      this.flush(child);
    }
    this.disposed = true;
    for (const child of this.children.values()) child.checkpoint = undefined;
    clearTimeout(this.notificationTimer);
    this.listeners.clear();
    this.results.clear();
    this.settledAttempts.clear();
    for (const waiter of [...this.waiters]) waiter.reject(new Error("Subagent manager is disposed"));
  }

  purge(): void {
    for (const child of this.children.values()) {
      child.controller?.abort(new Error("Subagent history purged"));
      child.checkpoint = undefined;
      clearTimeout(child.persistenceTimer);
    }
    this.children.clear();
    this.results.clear();
    this.settledAttempts.clear();
    this.checkWaiters();
    this.store?.remove(this.parentSessionId);
    this.notify(true);
  }
}
