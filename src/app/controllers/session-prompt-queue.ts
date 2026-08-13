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
  /** Structured result of the last settled turn, whoever started it. */
  readonly lastTurnResult?: (() => TurnResult | undefined) | undefined;
}

function pausedQueueNotice(decision: ContinuationDecision): string {
  const reason = decision.reason ?? "the turn did not succeed";
  return `queued prompts paused because ${reason}. Send or edit them when ready.`;
}

export class SessionPromptQueue {
  private readonly items: string[] = [];
  private priorityPrompt: string | undefined;
  private priorityQueueIndex: number | undefined;
  private nextDisplayPrompt: string | null | undefined;
  private nextDisplayArmed = false;
  private activeDrain: Promise<TurnResult[]> | undefined;

  constructor(private readonly deps: SessionPromptQueueDeps) {}

  snapshot(): readonly string[] {
    return [...this.items];
  }

  hasPending(): boolean {
    return this.items.length > 0 || this.priorityPrompt !== undefined;
  }

  clear(clearDisplay = false): void {
    this.items.length = 0;
    this.priorityPrompt = undefined;
    this.priorityQueueIndex = undefined;
    if (clearDisplay) {
      this.nextDisplayPrompt = undefined;
      this.nextDisplayArmed = false;
    }
  }

  enqueue(prompt: string, options?: TurnDisplayOptions): void {
    if (options && "displayPrompt" in options) {
      this.nextDisplayPrompt = options.displayPrompt;
      this.nextDisplayArmed = true;
    }
    const text = prompt.trim();
    if (!text) return;
    this.items.push(text);
    this.deps.notifyState();
  }

  remove(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    this.items.splice(index, 1);
    this.deps.notifyState();
  }

  take(index: number): string | undefined {
    if (index < 0 || index >= this.items.length) return undefined;
    const [text] = this.items.splice(index, 1);
    this.deps.notifyState();
    return text;
  }

  edit(index: number, text: string): void {
    if (index < 0 || index >= this.items.length) return;
    this.items[index] = text;
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
    if (moved !== undefined) this.items.splice(toIndex, 0, moved);
    this.deps.notifyState();
  }

  sendNow(index: number): void {
    const text = this.take(index);
    if (text === undefined) return;
    if (this.deps.isRunning()) {
      this.priorityPrompt = text;
      this.priorityQueueIndex = index;
      this.deps.abort("steer");
      return;
    }
    void this.submit(text);
  }

  enqueuePriority(prompt: string, displayPrompt?: string | undefined): void {
    const text = prompt.trim();
    if (!text) return;
    this.priorityPrompt = text;
    this.priorityQueueIndex = undefined;
    if (displayPrompt !== undefined) {
      this.nextDisplayPrompt = displayPrompt;
      this.nextDisplayArmed = true;
    }
    this.deps.notifyState();
  }

  async continue(): Promise<void> {
    await this.drain();
  }

  settle(result: TurnResult): void {
    if (this.activeDrain || this.deps.isRunning()) return;
    if (this.priorityPrompt !== undefined || queueContinuationDecision(result).proceed) {
      void this.drain();
    }
  }

  preservePendingPriority(): void {
    if (this.priorityPrompt === undefined) return;
    if (this.priorityQueueIndex !== undefined) {
      const index = Math.max(0, Math.min(this.priorityQueueIndex, this.items.length));
      this.items.splice(index, 0, this.priorityPrompt);
    } else {
      this.nextDisplayPrompt = undefined;
      this.nextDisplayArmed = false;
    }
    this.priorityPrompt = undefined;
    this.priorityQueueIndex = undefined;
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
    if (options && "displayPrompt" in options) {
      this.nextDisplayArmed = false;
      this.nextDisplayPrompt = undefined;
      return this.deps.runTurn(prompt, options);
    }
    return this.deps.runTurn(prompt, this.consumeDisplay() ?? options);
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
    if (this.priorityPrompt !== undefined && !this.deps.isRunning()) {
      const priority = this.priorityPrompt;
      this.priorityPrompt = undefined;
      this.priorityQueueIndex = undefined;
      const priorityResult = await this.deps.runTurn(
        priority,
        this.consumeDisplay(),
      );
      results.push(priorityResult);
      const decision = queueContinuationDecision(priorityResult);
      if (!decision.proceed) {
        if (this.items.length > 0) this.deps.notice(pausedQueueNotice(decision));
        return results;
      }
    }
    while (this.items.length > 0 && !this.deps.isRunning()) {
      const gate = this.continuationGate();
      if (!gate.proceed) {
        this.deps.notice(pausedQueueNotice(gate));
        break;
      }
      const next = this.items.shift();
      if (next === undefined) break;
      this.deps.notifyState();
      const result = await this.deps.runTurn(next);
      results.push(result);
      const decision = queueContinuationDecision(result);
      if (!decision.proceed) {
        if (this.items.length > 0) this.deps.notice(pausedQueueNotice(decision));
        break;
      }
    }
    return results;
  }

  private consumeDisplay(): TurnDisplayOptions | undefined {
    if (!this.nextDisplayArmed) return undefined;
    this.nextDisplayArmed = false;
    const displayPrompt = this.nextDisplayPrompt;
    this.nextDisplayPrompt = undefined;
    return { displayPrompt };
  }
}
