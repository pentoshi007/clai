import type { PersistedQueuedPrompt } from "../ports/persistence-port.js";
import type { TurnResult } from "./turn-controller.js";
import {
  queueContinuationDecision,
  type ContinuationDecision,
} from "./turn-continuation.js";

export interface TurnDisplayOptions {
  displayPrompt?: string | null | undefined;
  internal?: boolean | undefined;
}

interface SessionPromptQueueDeps {
  readonly isRunning: () => boolean;
  readonly abort: (reason?: string) => void;
  readonly notifyState: () => void;
  readonly notice: (text: string) => void;
  readonly runTurn: (
    prompt: string,
    options?: TurnDisplayOptions & { readonly onSubmitted?: (() => void) | undefined },
  ) => Promise<TurnResult>;
  readonly load?: (() => readonly PersistedQueuedPrompt[]) | undefined;
  readonly save?: ((prompts: readonly PersistedQueuedPrompt[]) => void) | undefined;
  readonly lastTurnResult?: (() => TurnResult | undefined) | undefined;
}

interface PromptEntry {
  readonly id: number;
  text: string;
  readonly options?: TurnDisplayOptions | undefined;
  readonly preserveOnCancel: boolean;
}

function pausedQueueNotice(decision: ContinuationDecision): string {
  const reason = decision.reason ?? "the turn did not succeed";
  return `queued prompts paused because ${reason}. Send or edit them when ready.`;
}

export class SessionPromptQueue {
  private readonly items: PromptEntry[] = [];
  private priorityId: number | undefined;
  private nextId = 0;
  private activeDrain: Promise<TurnResult[]> | undefined;
  private inFlight: PromptEntry | undefined;
  private editing: PromptEntry | undefined;
  private generation = 0;

  constructor(private readonly deps: SessionPromptQueueDeps) {}

  rebind(): void {
    this.detach();
    for (const entry of this.deps.load?.() ?? []) {
      this.items.push({ id: entry.id, text: entry.text, preserveOnCancel: true,
        ...(entry.displayPrompt !== undefined ? { options: { displayPrompt: entry.displayPrompt } } : {}),
      });
      this.nextId = Math.max(this.nextId, entry.id);
    }
  }

  detach(): void {
    this.generation += 1;
    this.items.length = 0;
    this.inFlight = undefined;
    this.editing = undefined;
    this.priorityId = undefined;
    this.activeDrain = undefined;
  }

  private changed(): void {
    const priority = this.items.find((entry) => entry.id === this.priorityId);
    const waiting = priority ? [priority, ...this.items.filter((entry) => entry !== priority)] : this.items;
    const pending = [this.inFlight, this.editing, ...waiting];
    const records = pending.flatMap((entry): PersistedQueuedPrompt[] => {
      if (!entry?.preserveOnCancel || entry.options?.internal) return [];
      return [{ id: entry.id, text: entry.text,
        ...(entry.options?.displayPrompt !== undefined ? { displayPrompt: entry.options.displayPrompt } : {}),
      }];
    });
    this.deps.save?.(records);
    this.deps.notifyState();
  }

  snapshot(): readonly string[] {
    return this.items.map((entry) => entry.text);
  }

  hasPending(): boolean {
    return this.items.length > 0;
  }

  clear(): void {
    this.detach();
    this.changed();
  }

  enqueue(prompt: string, options?: TurnDisplayOptions): void {
    const entry = this.editedEntry(prompt, options) ?? this.createEntry(prompt, options, true);
    if (!entry) return;
    this.items.push(entry);
    this.changed();
  }

  remove(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    const [removed] = this.items.splice(index, 1);
    if (removed?.id === this.priorityId) this.priorityId = undefined;
    this.changed();
  }

  take(index: number): string | undefined {
    if (index < 0 || index >= this.items.length) return undefined;
    const [entry] = this.items.splice(index, 1);
    if (entry?.id === this.priorityId) this.priorityId = undefined;
    if (this.editing) this.items.unshift(this.editing);
    this.editing = entry;
    this.changed();
    return entry?.text;
  }

  edit(index: number, text: string): void {
    if (index < 0 || index >= this.items.length) return;
    if (!text.trim()) { this.remove(index); return; }
    this.items[index]!.text = text;
    this.changed();
  }

  reorder(fromIndex: number, toIndex: number): void {
    if (
      fromIndex < 0 ||
      fromIndex >= this.items.length ||
      toIndex < 0 ||
      toIndex >= this.items.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const [moved] = this.items.splice(fromIndex, 1);
    if (moved) this.items.splice(toIndex, 0, moved);
    this.changed();
  }

  sendNow(index: number): void {
    const entry = this.items[index];
    if (!entry) return;
    if (this.deps.isRunning()) {
      this.priorityId = entry.id;
      this.changed();
      this.deps.abort("steer");
      return;
    }
    void this.submitEntry(entry).catch((error) => this.deps.notice(error instanceof Error ? error.message : "could not submit queued prompt"));
  }

  enqueuePriority(prompt: string, displayPrompt?: string | undefined): void {
    const options =
      { internal: true, ...(displayPrompt !== undefined ? { displayPrompt } : {}) };
    const entry = this.createEntry(prompt, options, false);
    if (!entry) return;
    this.items.unshift(entry);
    this.priorityId = entry.id;
    this.changed();
  }

  async continue(): Promise<void> {
    await this.drain();
  }

  settle(result: TurnResult): void {
    if (this.activeDrain || this.inFlight || this.deps.isRunning()) return;
    if (this.priorityId !== undefined || queueContinuationDecision(result).proceed) {
      void this.drain();
    }
  }

  preservePendingPriority(): void {
    const priorityId = this.priorityId;
    if (priorityId === undefined) return;
    this.priorityId = undefined;
    const index = this.items.findIndex((entry) => entry.id === priorityId);
    if (index >= 0 && !this.items[index]!.preserveOnCancel) {
      this.items.splice(index, 1);
    }
    this.changed();
  }

  private continuationGate(): ContinuationDecision {
    const last = this.deps.lastTurnResult?.();
    return last ? queueContinuationDecision(last) : { proceed: true };
  }

  async submit(
    prompt: string,
    options?: TurnDisplayOptions,
  ): Promise<TurnResult> {
    if (this.deps.isRunning()) {
      throw new Error("a turn is already running; enqueue() while busy");
    }
    const edited = this.editedEntry(prompt, options);
    return edited ? this.submitEntry(edited) : this.deps.runTurn(prompt, options);
  }

  async drain(): Promise<TurnResult[]> {
    if (this.activeDrain) return this.activeDrain;
    if (this.deps.isRunning()) return [];
    const drain = this.drainPending();
    this.activeDrain = drain;
    try {
      return await drain;
    } finally {
      if (this.activeDrain === drain) this.activeDrain = undefined;
    }
  }

  private async drainPending(): Promise<TurnResult[]> {
    const results: TurnResult[] = [];
    const generation = this.generation;
    while (generation === this.generation && !this.deps.isRunning()) {
      const priority = this.takePriorityEntry();
      let entry = priority;
      if (!entry) {
        if (this.items.length === 0) break;
        const gate = this.continuationGate();
        if (!gate.proceed) {
          this.deps.notice(pausedQueueNotice(gate));
          break;
        }
        entry = this.items[0];
        if (!entry) break;
      }

      const result = await this.submitEntry(entry);
      results.push(result);
      if (generation !== this.generation) break;
      if (this.items.includes(entry)) {
        this.deps.notice("queued prompts paused because the model request was not submitted. Send or edit them when ready.");
        break;
      }
      const decision = queueContinuationDecision(result);
      if (!decision.proceed && this.priorityId === undefined) {
        if (this.items.length > 0) this.deps.notice(pausedQueueNotice(decision));
        break;
      }
    }
    return results;
  }

  private takePriorityEntry(): PromptEntry | undefined {
    const priorityId = this.priorityId;
    if (priorityId === undefined) return undefined;
    this.priorityId = undefined;
    const index = this.items.findIndex((entry) => entry.id === priorityId);
    if (index < 0) return undefined;
    return this.items[index];
  }

  private async submitEntry(entry: PromptEntry): Promise<TurnResult> {
    const generation = this.generation;
    const index = this.items.indexOf(entry);
    if (index >= 0) this.items.splice(index, 1);
    this.inFlight = entry;
    this.changed();
    const onSubmitted = (): void => {
      if (generation !== this.generation || this.inFlight !== entry) return;
      this.inFlight = undefined;
      this.changed();
    };
    try {
      return await this.deps.runTurn(entry.text, { ...entry.options, onSubmitted });
    } finally {
      if (generation === this.generation && this.inFlight === entry) {
        this.inFlight = undefined;
        this.items.unshift(entry);
        this.changed();
      }
    }
  }

  private editedEntry(prompt: string, options?: TurnDisplayOptions): PromptEntry | undefined {
    if (!this.editing || options?.internal || !prompt.trim()) return undefined;
    const entry: PromptEntry = { ...this.editing, text: prompt.trim(), options };
    this.editing = undefined;
    return entry;
  }

  private createEntry(
    prompt: string,
    options: TurnDisplayOptions | undefined,
    preserveOnCancel: boolean,
  ): PromptEntry | undefined {
    const text = prompt.trim();
    if (!text) return undefined;
    this.nextId += 1;
    return {
      id: this.nextId,
      text,
      ...(options ? { options: { ...options } } : {}),
      preserveOnCancel,
    };
  }
}
