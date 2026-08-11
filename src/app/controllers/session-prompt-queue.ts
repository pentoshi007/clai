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
  private nextDisplayPrompt: string | null | undefined;
  private nextDisplayArmed = false;
  private continuing = false;

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
      this.deps.abort("steer");
      return;
    }
    void this.submit(text).then(() => this.continue());
  }

  enqueuePriority(prompt: string, displayPrompt?: string | undefined): void {
    const text = prompt.trim();
    if (!text) return;
    this.priorityPrompt = text;
    if (displayPrompt !== undefined) {
      this.nextDisplayPrompt = displayPrompt;
      this.nextDisplayArmed = true;
    }
    this.deps.notifyState();
  }

  async continue(): Promise<void> {
    if (this.continuing || this.deps.isRunning()) return;
    this.continuing = true;
    try {
      while (!this.deps.isRunning()) {
        let next: string | undefined;
        if (this.priorityPrompt !== undefined) {
          // An explicit steer always runs, whatever the previous turn did.
          next = this.priorityPrompt;
          this.priorityPrompt = undefined;
        } else if (this.items.length > 0) {
          const gate = this.continuationGate();
          if (!gate.proceed) {
            this.deps.notice(pausedQueueNotice(gate));
            break;
          }
          next = this.items.shift();
          this.deps.notifyState();
        } else {
          break;
        }
        if (next === undefined || !next.trim()) continue;
        await this.deps.runTurn(next, this.consumeDisplay());
      }
    } finally {
      this.continuing = false;
    }
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
    const results: TurnResult[] = [];
    if (this.priorityPrompt !== undefined && !this.deps.isRunning()) {
      const priority = this.priorityPrompt;
      this.priorityPrompt = undefined;
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
