import type { ChatMessage, Mode, ProviderId } from "../../types.js";
import { createSessionPolicy, type SessionPolicy } from "../../agent/session-policy.js";
import {
  asSessionId,
  type AnyAppEvent,
  type SessionId,
  type TurnId,
} from "../events/app-event.js";
import {
  EventSequencer,
  type Clock,
  type IdFactory,
} from "../events/sequencer.js";
import { OutputSpool } from "../events/event-buffer.js";
import type { AgentPort, RunTurnRequest } from "../ports/agent-port.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import type { ConfirmationPort } from "../ports/confirm-port.js";
import type { SecretPort } from "../ports/secret-port.js";
import { TurnController, type TurnResult } from "./turn-controller.js";
import { CompositeDisposable, type Disposable } from "./disposable.js";

export interface SessionState {
  readonly sessionId: SessionId;
  readonly mode: Mode;
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly running: boolean;
  readonly historyLength: number;
  readonly queued: readonly string[];
}

export interface SessionControllerDeps {
  readonly agent: AgentPort;
  readonly persistence: PersistencePort;
  readonly emit: (event: AnyAppEvent) => void;
  readonly sessionId?: string | undefined;
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly mode?: Mode | undefined;
  readonly confirm?: ConfirmationPort | undefined;
  readonly requestSecret?: SecretPort["request"] | undefined;
  readonly idFactory?: IdFactory | undefined;
  readonly clock?: Clock | undefined;
  readonly mintTurnId?: (() => TurnId) | undefined;
}

/**
 * Owns session-level state (mode, provider/model, cumulative history, queued
 * drafts) and runs turns through a single `TurnController`. Cumulative history
 * follows the current runner contract: `onMessages` hands back the full
 * conversation for the turn (prior context + this turn), which replaces the
 * stored history and is persisted on completion.
 */
export class SessionController implements Disposable {
  readonly sessionId: SessionId;
  readonly spool = new OutputSpool();

  private readonly sequencer: EventSequencer;
  private readonly turn: TurnController;
  private readonly policy: SessionPolicy;
  private readonly disposables = new CompositeDisposable();

  private history: ChatMessage[] = [];
  private readonly queue: string[] = [];
  private provider: ProviderId | undefined;
  private model: string | undefined;
  private mode: Mode;

  constructor(private readonly deps: SessionControllerDeps) {
    this.sessionId = asSessionId(
      deps.sessionId ?? `sess-${Date.now().toString(36)}`,
    );
    this.provider = deps.provider;
    this.model = deps.model;
    this.mode = deps.mode ?? "agent";
    this.policy = createSessionPolicy(this.sessionId);
    this.sequencer = new EventSequencer(
      this.sessionId,
      deps.idFactory,
      deps.clock,
    );
    this.turn = this.disposables.add(
      new TurnController({
        agent: deps.agent,
        sequencer: this.sequencer,
        spool: this.spool,
        emit: deps.emit,
        mintTurnId: deps.mintTurnId,
      }),
    );
  }

  getState(): SessionState {
    return {
      sessionId: this.sessionId,
      mode: this.mode,
      provider: this.provider,
      model: this.model,
      running: this.turn.running,
      historyLength: this.history.length,
      queued: [...this.queue],
    };
  }

  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  setProvider(provider: ProviderId | undefined): void {
    this.provider = provider;
  }

  setModel(model: string | undefined): void {
    this.model = model;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  loadHistory(messages: readonly ChatMessage[]): void {
    this.history = [...messages];
  }

  enqueue(prompt: string): void {
    this.queue.push(prompt);
  }

  queued(): readonly string[] {
    return [...this.queue];
  }

  removeQueued(index: number): void {
    if (index >= 0 && index < this.queue.length) this.queue.splice(index, 1);
  }

  abort(): void {
    this.turn.abort();
  }

  async submit(prompt: string): Promise<TurnResult> {
    if (this.turn.running) {
      throw new Error("a turn is already running; enqueue() while busy");
    }
    return this.runTurn(prompt);
  }

  /** Runs queued prompts one at a time while idle; stops on first non-completion. */
  async drain(): Promise<TurnResult[]> {
    const results: TurnResult[] = [];
    while (this.queue.length > 0 && !this.turn.running) {
      const next = this.queue.shift();
      if (next === undefined) break;
      const result = await this.runTurn(next);
      results.push(result);
      if (result.status !== "completed") break;
    }
    return results;
  }

  private async runTurn(prompt: string): Promise<TurnResult> {
    const request: RunTurnRequest = {
      prompt,
      provider: this.provider,
      model: this.model,
      history: this.history,
    };
    const result = await this.turn.run(request, {
      confirm: this.deps.confirm,
      requestSecret: this.deps.requestSecret,
      session: this.policy,
      onMessages: (messages) => {
        this.history = messages;
      },
    });
    if (result.status === "completed") {
      await this.deps.persistence.saveSession(this.history);
    }
    return result;
  }

  dispose(): void {
    this.disposables.dispose();
  }
}
