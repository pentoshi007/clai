import type { TurnResult } from "./turn-controller.js";
import {
  queueContinuationDecision,
  type ContinuationDecision,
} from "./turn-continuation.js";

export interface TurnDisplayOptions {
  displayPrompt?: string | null | undefined;
}

interface SessionPromptQueueDeps {
  readonly isRunning: () => boolean;
  readonly abort: (reason?: string) => void;
  readonly notifyState: () => void;
  readonly notice: (text: string) => void;
  readonly runTurn: (
    prompt: string,
    options?: TurnDisplayOptions,
  ) => Promise<TurnResult>;
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

  constructor(private readonly deps: SessionPromptQueueDeps) {}

  snapshot(): readonly string[] {
    return this.items.map((entry) => entry.text);
  }

  hasPending(): boolean {
    return this.items.length > 0;
  }

  clear(): void {
    this.items.length = 0;
    this.priorityId = undefined;
  }

  enqueue(prompt: string, options?: TurnDisplayOptions): void {
    const entry = this.createEntry(prompt, options, true);
    if (!entry) return;
    this.items.push(entry);
    this.deps.notifyState();
  }

  remove(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    const [removed] = this.items.splice(index, 1);
    if (removed?.id === this.priorityId) this.priorityId = undefined;
    this.deps.notifyState();
  }

  take(index: number): string | undefined {
    if (index < 0 || index >= this.items.length) return undefined;
    const [entry] = this.items.splice(index, 1);
    if (entry?.id === this.priorityId) this.priorityId = undefined;
    this.deps.notifyState();
    return entry?.text;
  }

  edit(index: number, text: string): void {
    if (index < 0 || index >= this.items.length) return;
    this.items[index]!.text = text;
    this.deps.notifyState();
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
    this.deps.notifyState();
  }

  sendNow(index: number): void {
    const entry = this.items[index];
    if (!entry) return;
    if (this.deps.isRunning()) {
      this.priorityId = entry.id;
      this.deps.notifyState();
      this.deps.abort("steer");
      return;
    }
    this.items.splice(index, 1);
    this.deps.notifyState();
    void this.submitEntry(entry);
  }

  enqueuePriority(prompt: string, displayPrompt?: string | undefined): void {
    const options =
      displayPrompt === undefined ? undefined : { displayPrompt };
    const entry = this.createEntry(prompt, options, false);
    if (!entry) return;
    this.items.unshift(entry);
    this.priorityId = entry.id;
    this.deps.notifyState();
  }

  async continue(): Promise<void> {
    await this.drain();
  }

  settle(result: TurnResult): void {
    if (this.activeDrain || this.deps.isRunning()) return;
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
    this.deps.notifyState();
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
    return this.deps.runTurn(prompt, options);
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
    while (!this.deps.isRunning()) {
      const priority = this.takePriorityEntry();
      let entry = priority;
      if (!entry) {
        if (this.items.length === 0) break;
        const gate = this.continuationGate();
        if (!gate.proceed) {
          this.deps.notice(pausedQueueNotice(gate));
          break;
        }
        entry = this.items.shift();
        if (!entry) break;
        this.deps.notifyState();
      }

      const result = await this.submitEntry(entry);
      results.push(result);
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
    const [entry] = this.items.splice(index, 1);
    this.deps.notifyState();
    return entry;
  }

  private submitEntry(entry: PromptEntry): Promise<TurnResult> {
    return this.deps.runTurn(entry.text, entry.options);
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
