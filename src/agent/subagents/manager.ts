import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { restoreSubagentRun, sanitizeSubagentRun, sanitizeSubagentText, SUBAGENT_LIMITS } from "../../store/subagents.js";
import type { SubagentAssignment, SubagentEvent, SubagentRun, SubagentStore, SubagentWorker } from "./types.js";

type Child = {
  run: SubagentRun;
  assignment: SubagentAssignment;
  assistantSequence?: number | undefined;
  controller?: AbortController | undefined;
  persistenceTimer?: ReturnType<typeof setTimeout> | undefined;
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
  private readonly workerContext = new AsyncLocalStorage<boolean>();
  private notificationTimer?: ReturnType<typeof setTimeout> | undefined;
  private readonly worker: SubagentWorker;
  private readonly store: SubagentStore | undefined;

  constructor(readonly parentSessionId: string, options: { worker?: SubagentWorker; store?: SubagentStore } = {}) {
    if (!parentSessionId || parentSessionId.length > 256 || sanitizeSubagentText(parentSessionId) !== parentSessionId) throw new Error("Invalid parent session ID");
    this.worker = options.worker ?? defaultWorker;
    this.store = options.store;
    if (this.store) {
      try {
        for (const value of this.store.load(parentSessionId).slice(0, SUBAGENT_LIMITS.records)) {
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
    if (inFlight.size >= 3) throw new Error("At most three subagents may run concurrently across sessions");
  }

  private assertUnique(assignment: SubagentAssignment): void {
    if ([...inFlight.values()].includes(fingerprint(assignment))) throw new Error("Duplicate active subagent assignment");
  }

  start(value: SubagentAssignment): SubagentRun {
    this.assertAvailable();
    const assignment = this.assignment(value);
    this.assertUnique(assignment);
    if (this.children.size >= SUBAGENT_LIMITS.records) {
      throw new Error("Subagent retention limit reached (24 records); restart an existing child or explicitly purge history");
    }
    const now = Date.now();
    const child: Child = { assignment, run: { ...assignment, id: randomUUID(), parentSessionId: this.parentSessionId, attempt: 1, status: "running", createdAt: now, updatedAt: now, events: [] } };
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

  get(id: string): SubagentRun | undefined {
    const child = this.children.get(id);
    return child ? this.snapshot(child.run) : undefined;
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

  restart(id: string): SubagentRun {
    this.assertAvailable();
    const child = this.child(id);
    if (child.controller) throw new Error("Wait for the previous attempt to stop before restarting");
    this.assertUnique(child.assignment);
    const previous = child.run;
    const summary = `Attempt ${previous.attempt}: ${previous.status}\n${previous.report ?? previous.error ?? "No report"}`;
    const events = [...previous.events, { kind: "notice" as const, text: summary, timestamp: Date.now(), sequence: (previous.events.at(-1)?.sequence ?? 0) + 1 }];
    child.run = { ...previous, ...child.assignment, attempt: previous.attempt + 1, status: "running", report: undefined, error: undefined, updatedAt: Date.now(), events: this.boundEvents(events) };
    this.launch(child);
    return this.snapshot(child.run);
  }

  private boundEvents(events: readonly SubagentEvent[]): readonly SubagentEvent[] {
    const retained = events.slice(-SUBAGENT_LIMITS.events);
    let total = retained.reduce((sum, event) => sum + event.text.length, 0);
    while (total > SUBAGENT_LIMITS.chars && retained.length > 1) total -= retained.shift()!.text.length;
    return retained.map((event) => ({ ...event, text: event.text.slice(0, SUBAGENT_LIMITS.chars) }));
  }

  private launch(child: Child): void {
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
      return this.workerContext.run(true, () => this.worker({ run: inputRun, signal: controller.signal, emit }));
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
    child.run = this.snapshot({
      ...child.run, updatedAt: Date.now(), status: stopped ? "stopped" : failed ? "error" : "completed",
      report: stopped || failed ? undefined : report,
      error: stopped ? "Stopped by parent" : failed ? sanitizeSubagentText(error instanceof Error ? error.message : error === undefined ? "Worker returned no report" : String(error)).slice(0, 4096) : undefined,
    });
    if (!this.disposed) this.changed(child, true);
  }

  wait(id: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<SubagentRun> {
    if (this.disposed) return Promise.reject(new Error("Subagent manager is disposed"));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000) return Promise.reject(new Error("Wait timeout must be between 0 and 30000 milliseconds"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const run = this.get(id);
    if (!run) return Promise.reject(new Error("Unknown child ID in this session"));
    if (terminal(run.status) || timeoutMs === 0) return Promise.resolve(run);
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.waiters.delete(waiter);
      };
      const fail = (error: Error): void => { cleanup(); reject(error); };
      const finish = (): void => {
        const current = this.get(id);
        cleanup();
        if (current) resolve(current);
        else reject(new Error("Subagent record was removed"));
      };
      const abort = (): void => { cleanup(); reject(signal?.reason ?? new DOMException("Aborted", "AbortError")); };
      const waiter: Waiter = { reject: fail, check: () => {
        const current = this.get(id);
        if (!current || terminal(current.status)) finish();
      } };
      const timer = setTimeout(finish, timeoutMs);
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
    clearTimeout(this.notificationTimer);
    this.listeners.clear();
    for (const waiter of [...this.waiters]) waiter.reject(new Error("Subagent manager is disposed"));
  }

  purge(): void {
    for (const child of this.children.values()) {
      child.controller?.abort(new Error("Subagent history purged"));
      clearTimeout(child.persistenceTimer);
    }
    this.children.clear();
    this.checkWaiters();
    this.store?.remove(this.parentSessionId);
    this.notify(true);
  }
}
