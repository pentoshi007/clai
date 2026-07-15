import type { ChatMessage, Mode, ProviderId } from "../../types.js";
import {
  compactMessagesWithSummary,
  estimateMessagesTokens,
  type CompactResult,
} from "../../agent/context-manager.js";
import { createSessionPolicy, type SessionPolicy } from "../../agent/session-policy.js";
import { generateSessionTitle } from "../../agent/session-title.js";
import { completeWithProvider } from "../../llm/router.js";
import { getConfig, getProviderModel } from "../../store/config.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../../tui/state.js";
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
  /** True while /compact is awaiting the summarizer (status strip). */
  readonly compacting: boolean;
  readonly historyLength: number;
  readonly queued: readonly string[];
  /** AI-generated (or last known) display name for this session. */
  readonly title: string | undefined;
}

export type NoticeLevel = "info" | "warn";

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
  /**
   * Optional snapshot of the visual transcript for history.db (classic shape).
   * When provided, completed turns upsert session + transcript so /history
   * can restore tools and prompts, not only ChatMessage[].
   */
  readonly getTranscriptSnapshot?: (() => ClassicTranscriptItem[] | undefined) | undefined;
  /** When true, never persist sessions or generate AI titles (CLI --no-history). */
  readonly noHistory?: boolean | undefined;
}

/**
 * Owns session-level state (mode, provider/model, cumulative history, queued
 * drafts) and runs turns through a single `TurnController`. Cumulative history
 * follows the current runner contract: `onMessages` hands back the full
 * conversation for the turn (prior context + this turn), which replaces the
 * stored history and is persisted on completion.
 */
export type TurnEndListener = (result: TurnResult) => void;
export type SessionStateListener = () => void;

function mintSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class SessionController implements Disposable {
  readonly spool = new OutputSpool();

  private sessionIdValue: SessionId;
  private readonly sequencer: EventSequencer;
  private readonly turn: TurnController;
  private policy: SessionPolicy;
  private readonly disposables = new CompositeDisposable();
  private readonly turnEndListeners = new Set<TurnEndListener>();
  private readonly stateListeners = new Set<SessionStateListener>();

  private history: ChatMessage[] = [];
  private readonly queue: string[] = [];
  /**
   * Prompt promoted by "Send now" while a turn was running. After the abort
   * settles, {@link continueQueue} runs this before any remaining queue items.
   */
  private priorityPrompt: string | undefined;
  /** Re-entrancy guard for {@link continueQueue}. */
  private continuingQueue = false;
  private provider: ProviderId | undefined;
  private model: string | undefined;
  private mode: Mode;
  private compactingFlag = false;
  /** Display name written into history.db (AI title or explicit /save name). */
  private sessionTitle: string | undefined;
  /** User-message count at last successful AI title (classic refresh cadence). */
  private titledAtUserCount = 0;
  private titleInFlight = false;

  constructor(private readonly deps: SessionControllerDeps) {
    this.sessionIdValue = asSessionId(deps.sessionId ?? mintSessionId());
    this.provider = deps.provider;
    this.model = deps.model;
    this.mode = deps.mode ?? "agent";
    this.policy = createSessionPolicy(this.sessionIdValue);
    this.sequencer = new EventSequencer(
      this.sessionIdValue,
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

  get sessionId(): SessionId {
    return this.sessionIdValue;
  }

  getState(): SessionState {
    return {
      sessionId: this.sessionIdValue,
      mode: this.mode,
      provider: this.provider,
      model: this.model,
      running: this.turn.running,
      compacting: this.compactingFlag,
      historyLength: this.history.length,
      queued: [...this.queue],
      title: this.sessionTitle,
    };
  }

  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  /** Subscribe to transient UI state such as running/queue status. */
  subscribe(listener: SessionStateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  setProvider(provider: ProviderId | undefined): void {
    this.provider = provider;
    this.notifyState();
  }

  setModel(model: string | undefined): void {
    this.model = model;
    this.notifyState();
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.notifyState();
  }

  /**
   * Replace model history (and optionally rebind the session id so later
   * autosaves update the resumed history row).
   */
  loadHistory(
    messages: readonly ChatMessage[],
    options: { sessionId?: string; title?: string | undefined } = {},
  ): void {
    if (this.turn.running) this.turn.abort();
    this.history = [...messages];
    this.queue.length = 0;
    this.priorityPrompt = undefined;
    this.spool.clear();
    // Keep the resumed session's existing title; only refresh after the user
    // adds more turns (same cadence as classic TUI).
    this.sessionTitle = options.title;
    this.titledAtUserCount = messages.filter((m) => m.role === "user").length;
    this.titleInFlight = false;
    if (options.sessionId) {
      this.sessionIdValue = asSessionId(options.sessionId);
      this.sequencer.rebind(this.sessionIdValue);
      this.policy = createSessionPolicy(this.sessionIdValue);
    }
    this.notifyState();
  }

  notice(level: NoticeLevel, text: string): void {
    this.deps.emit(this.sequencer.build("notice", { level, text }, undefined));
  }

  allowTool(name: string): void {
    this.policy.allow.add(name);
  }

  disallowTool(name: string): void {
    this.policy.allow.delete(name);
  }

  allowedTools(): readonly string[] {
    return [...this.policy.allow];
  }

  /**
   * Clear conversation state. When `mintNewId` is true (for `/new`/`/clean`),
   * remint the session id so subsequent autosave does not overwrite the prior
   * history row.
   */
  reset(options: { mintNewId?: boolean } = {}): void {
    if (this.turn.running) this.turn.abort();
    this.history = [];
    this.queue.length = 0;
    this.priorityPrompt = undefined;
    this.sessionTitle = undefined;
    this.titledAtUserCount = 0;
    this.titleInFlight = false;
    this.spool.clear();
    if (options.mintNewId) {
      this.sessionIdValue = asSessionId(mintSessionId());
      this.sequencer.rebind(this.sessionIdValue);
    }
    this.policy = createSessionPolicy(this.sessionIdValue);
    this.notifyState();
  }

  async compact(
    sessionTranscript?: string,
    keepRecent = 2,
    signal?: AbortSignal,
  ): Promise<CompactResult> {
    if (this.turn.running) throw new Error("a turn is already running");
    if (this.compactingFlag) throw new Error("compaction already in progress");

    // Fall back to config defaults so /compact works even before a turn sets
    // the live provider/model on the session controller — including right after
    // /history resume when no turn has run yet in this process.
    const cfg = getConfig();
    const provider = this.provider ?? (cfg.defaultProvider as ProviderId | undefined);
    const model = this.model ?? cfg.defaultModel;

    // Snapshot history at start: includes /history resume + any new turns.
    // compactMessagesWithSummary keeps the recent tail and summarizes the rest
    // together with the visual session transcript (when provided).
    const historySnapshot = [...this.history];

    this.compactingFlag = true;
    this.notifyState();
    try {
      const completeSummary = async (prompt: string): Promise<string> => {
        const response = await completeWithProvider({
          provider,
          model,
          messages: [
            {
              role: "system",
              content: "You compress conversation history into accurate continuation memory.",
            },
            { role: "user", content: prompt },
          ],
          temperature: 0.1,
          maxTokens: 2_048,
          signal,
        });
        return response.text;
      };
      const result = await compactMessagesWithSummary(
        historySnapshot,
        async (prompt) => {
          const chunkSize = 50_000;
          if (prompt.length <= chunkSize) return completeSummary(prompt);
          const chunks = Array.from(
            { length: Math.ceil(prompt.length / chunkSize) },
            (_, index) => prompt.slice(index * chunkSize, (index + 1) * chunkSize),
          );
          const partials: string[] = [];
          for (let index = 0; index < chunks.length; index += 1) {
            signal?.throwIfAborted();
            partials.push(
              await completeSummary(
                `Summarize part ${index + 1} of ${chunks.length} of one session. Preserve concrete goals, actions, commands, results, task state, failures, and remaining work.\n\n${chunks[index]}`,
              ),
            );
          }
          signal?.throwIfAborted();
          return completeSummary(
            "Merge these ordered partial session memories into one non-redundant continuation memory. Preserve all concrete facts and unresolved work. Use sections: User goals, Decisions and constraints, Work completed, Commands/tools and results, Current state, Remaining work.\n\n" +
              partials.map((part, index) => `PART ${index + 1}:\n${part}`).join("\n\n"),
          );
        },
        { budgetTokens: 0, keepRecent },
        sessionTranscript,
      );
      this.history = result.messages;
      this.notifyState();
      if (result.summarized && result.after !== result.before) {
        const memo =
          result.messages.find(
            (m) => m.role === "system" && m.content.startsWith("Session memory"),
          )?.content ?? "Compacted context";
        this.deps.emit(
          this.sequencer.build(
            "compacted",
            {
              summary: memo,
              beforeTokens: result.beforeTokens,
              afterTokens: result.afterTokens,
            },
            undefined,
          ),
        );
        // Persist the compacted model history + visual marker together.
        await this.persistNow();
      }
      return result;
    } finally {
      this.compactingFlag = false;
      this.notifyState();
    }
  }

  /** Persist current messages (+ optional visual transcript) under this session id. */
  async persistNow(name?: string): Promise<void> {
    if (this.deps.noHistory || getConfig().privateMode) return;
    if (this.history.length === 0) return;
    // Only sessions with a real user turn belong in /history (classic parity).
    if (!this.history.some((m) => m.role === "user")) return;
    if (name) this.sessionTitle = name;
    const transcript = this.deps.getTranscriptSnapshot?.();
    await this.deps.persistence.saveSession(this.history, {
      sessionId: this.sessionIdValue,
      name: name ?? this.sessionTitle,
      transcript,
    });
  }

  /**
   * Ask the model for a short conversation title and upsert it into history.
   * Cadence matches classic TUI: first completed exchange, then every +2 user
   * turns so the name tracks the evolving topic.
   */
  async maybeRefreshTitle(): Promise<void> {
    if (this.deps.noHistory || getConfig().privateMode) return;
    if (this.titleInFlight) return;
    const userCount = this.history.filter((m) => m.role === "user").length;
    const hasAssistant = this.history.some(
      (m) => m.role === "assistant" && m.content.trim().length > 0,
    );
    if (userCount === 0 || !hasAssistant) return;
    const shouldGenerate =
      this.titledAtUserCount === 0 || userCount - this.titledAtUserCount >= 2;
    if (!shouldGenerate) return;

    const provider = this.provider ?? getConfig().defaultProvider;
    const model = this.model ?? getProviderModel(provider);
    if (!provider || !model) return;

    this.titleInFlight = true;
    const sessionIdAtStart = this.sessionIdValue;
    const targetCount = userCount;
    try {
      const title = await generateSessionTitle(this.history, {
        provider,
        model,
      });
      if (!title) return;
      // Discard if the user started / resumed another session while waiting.
      if (this.sessionIdValue !== sessionIdAtStart) return;
      this.titledAtUserCount = targetCount;
      this.sessionTitle = title;
      await this.persistNow(title);
      this.notifyState();
    } catch {
      // Title is best-effort; derived name from first user message remains.
    } finally {
      this.titleInFlight = false;
    }
  }

  estimateContext(): { messages: number; tokens: number } {
    return {
      messages: this.history.length,
      tokens: estimateMessagesTokens(this.history),
    };
  }

  enqueue(prompt: string): void {
    const text = prompt.trim();
    if (!text) return;
    this.queue.push(text);
    this.notifyState();
  }

  queued(): readonly string[] {
    return [...this.queue];
  }

  removeQueued(index: number): void {
    if (index >= 0 && index < this.queue.length) {
      this.queue.splice(index, 1);
      this.notifyState();
    }
  }

  /**
   * Remove a queued draft and return its text (for "Edit" → composer).
   * Returns undefined when the index is out of range.
   */
  takeQueued(index: number): string | undefined {
    if (index < 0 || index >= this.queue.length) return undefined;
    const [text] = this.queue.splice(index, 1);
    this.notifyState();
    return text;
  }

  /** Edit a queued draft in place before it runs (INPUT-007). */
  editQueued(index: number, text: string): void {
    if (index >= 0 && index < this.queue.length) {
      this.queue[index] = text;
      this.notifyState();
    }
  }

  /** Move a queued draft to a new position before it runs (INPUT-007). */
  reorderQueued(fromIndex: number, toIndex: number): void {
    if (
      fromIndex < 0 ||
      fromIndex >= this.queue.length ||
      toIndex < 0 ||
      toIndex >= this.queue.length ||
      fromIndex === toIndex
    ) {
      return;
    }
    const [moved] = this.queue.splice(fromIndex, 1);
    if (moved !== undefined) this.queue.splice(toIndex, 0, moved);
    this.notifyState();
  }

  /**
   * Send a queued prompt immediately. If a turn is running, abort it first;
   * the chosen prompt runs next (ahead of any remaining queue). If idle,
   * submit it now.
   */
  sendQueuedNow(index: number): void {
    const text = this.takeQueued(index);
    if (text === undefined) return;
    if (this.turn.running) {
      this.priorityPrompt = text;
      this.turn.abort();
      this.notice("info", "interrupting · sending queued prompt now");
      return;
    }
    void this.submit(text).then(() => this.continueQueue());
  }

  abort(): void {
    this.turn.abort();
  }

  /**
   * After a turn settles, run any "send now" priority prompt, then drain the
   * queue one-by-one. Safe to call from onTurnEnd (re-entrancy guarded).
   */
  async continueQueue(): Promise<void> {
    if (this.continuingQueue || this.turn.running) return;
    this.continuingQueue = true;
    try {
      while (!this.turn.running) {
        let next: string | undefined;
        if (this.priorityPrompt !== undefined) {
          next = this.priorityPrompt;
          this.priorityPrompt = undefined;
        } else if (this.queue.length > 0) {
          next = this.queue.shift();
          this.notifyState();
        } else {
          break;
        }
        if (next === undefined || !next.trim()) continue;
        await this.runTurn(next);
      }
    } finally {
      this.continuingQueue = false;
    }
  }

  /** In-memory plan-approval flag consumed by the agent gate (CORE-005). */
  setPlanApproved(value: boolean): void {
    this.policy.planApproved.value = value;
  }

  isPlanApproved(): boolean {
    return this.policy.planApproved.value;
  }

  /** Fires after every turn settles (completed/aborted/error), including drain. */
  onTurnEnd(listener: TurnEndListener): () => void {
    this.turnEndListeners.add(listener);
    return () => this.turnEndListeners.delete(listener);
  }

  async submit(prompt: string): Promise<TurnResult> {
    if (this.turn.running) {
      throw new Error("a turn is already running; enqueue() while busy");
    }
    return this.runTurn(prompt);
  }

  /**
   * Runs queued prompts one at a time while idle; stops on first
   * non-completion. Prefer {@link continueQueue} from the UI so priority
   * ("send now") prompts are honored too.
   */
  async drain(): Promise<TurnResult[]> {
    const results: TurnResult[] = [];
    while (this.queue.length > 0 && !this.turn.running) {
      const next = this.queue.shift();
      if (next === undefined) break;
      this.notifyState();
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
    const pending = this.turn.run(request, {
      confirm: this.deps.confirm,
      requestSecret: this.deps.requestSecret,
      session: this.policy,
      onMessages: (messages) => {
        this.history = messages;
        this.notifyState();
      },
    });
    // `TurnController.run` marks itself active synchronously before its first
    // await, so this makes the RUNNING strip appear even before a provider
    // emits its first status event.
    this.notifyState();
    const result = await pending;
    if (result.status === "completed") {
      await this.persistNow();
      // Fire-and-forget AI title so the turn path is not blocked on a second
      // model call; classic TUI does the same after each completed exchange.
      void this.maybeRefreshTitle();
    }
    for (const listener of this.turnEndListeners) listener(result);
    this.notifyState();
    return result;
  }

  dispose(): void {
    this.turnEndListeners.clear();
    this.stateListeners.clear();
    this.disposables.dispose();
  }

  private notifyState(): void {
    for (const listener of this.stateListeners) listener();
  }
}
