import type {
  ChatMessage,
  Mode,
  ProviderId,
  SuccessfulRequestSnapshot,
  TokenUsage,
  ToolResult,
} from "../../types.js";
import {
  estimateMessagesTokens,
  type CompactResult,
} from "../../agent/context-manager.js";
import { repairToolProtocol } from "../../agent/tool-history.js";
import {
  formatContextChip,
  type ContextUsageSnapshot,
} from "../../llm/token-usage.js";
import type {
  ContextAttemptReference,
  ContextSnapshotV1,
} from "../../llm/context-snapshot.js";
import {
  compactedContextSnapshot,
  recordContextUsageSnapshot,
  resolveContextSnapshot as resolveSnapshot,
  restoredContextSnapshot,
  createContextProjector,
  estimatedContextSnapshot,
  type PartialUsageSnapshot,
  type ContextProjection,
  type ContextUsageTarget,
} from "./session-context-usage.js";
import { createSessionPolicy, type SessionPolicy } from "../../agent/session-policy.js";
import { previousTurnSignal } from "./turn-continuation.js";
import type { PreviousTurnSignal } from "../../agent/continue-orient.js";
import { buildTurnRequest } from "./session-turn-request.js";
import { resolveTurnInput } from "../../attachments/service.js";
import { clearTextOnlyModels } from "../../llm/tool-protocol.js";
import { prefetchProviderCatalog } from "../../llm/catalog-prefetch.js";
import { publishRouteReasoningVocabulary } from "../../llm/route-vocabulary.js";
import { getConfig, getProviderModel } from "../../store/config.js";
import { beginSessionWorkspace, getActiveSessionWorkspace, type SessionWorkspace } from "../../store/session-workspace.js";
import { materializeHistoryImages } from "../../store/history.js";
import {
  runSessionCompaction,
} from "./session-compact-helper.js";
import { settlePersistedResponderResults } from "./responder-settlement.js";
import type { TranscriptItem as ClassicTranscriptItem } from "../ports/transcript-item.js";
import { asSessionId, type AnyAppEvent, type SessionId, type TurnId } from "../events/app-event.js";
import { EventSequencer, type Clock, type IdFactory } from "../events/sequencer.js";
import { OutputSpool } from "../events/event-buffer.js";
import type { AgentPort, RunTurnRequest } from "../ports/agent-port.js";
import type { JobsPort } from "../ports/jobs-port.js";
import type { InteractiveSessionsPort } from "../ports/interactive-sessions-port.js";
import type { PersistencePort } from "../ports/persistence-port.js";
import { mergeCancelAllResult } from "./cancel-all-result.js";
import type { ConfirmationPort } from "../ports/confirm-port.js";
import type { SecretPort } from "../ports/secret-port.js";
import { TurnController, type TurnResult } from "./turn-controller.js";
import { CompositeDisposable, type Disposable } from "./disposable.js";
import {
  hasPersistableHistory,
  mintSessionId,
  pathBackedMessages,
  persistedContextUsage,
  SessionPersistenceQueue,
} from "./session-persistence.js";
import {
  SessionPromptQueue,
  type TurnDisplayOptions,
} from "./session-prompt-queue.js";
import {
  IDLE_RESPONDER_STATE,
  SessionResponder,
  type ResponderRuntimeState,
} from "./session-responder.js";
import { SessionContextLimits } from "./session-context-limits.js";
import {
  SessionUsageLedger,
  type SessionUsageReport,
} from "./session-usage-ledger.js";
import { completeForSessionNaming, SessionNamer } from "./session-naming.js";

export interface SessionState {
  readonly sessionId: SessionId;
  readonly mode: Mode;
  readonly provider: ProviderId | undefined;
  readonly model: string | undefined;
  readonly running: boolean;
  readonly compacting: boolean;
  readonly historyLength: number;
  readonly queued: readonly string[];
  readonly responder: ResponderRuntimeState;
  readonly title: string | undefined;
  /** Canonical versioned context measurement for runtime consumers. */
  readonly contextSnapshot: ContextSnapshotV1 | undefined;
  /** Six-field legacy projection retained for existing renderers. */
  readonly contextUsage: ContextUsageSnapshot | undefined;
  readonly contextChip: string | undefined;
}

export type NoticeLevel = "info" | "warn";

export interface SessionControllerDeps {
  readonly agent: AgentPort;
  readonly persistence: PersistencePort;
  readonly jobs?: JobsPort | undefined;
  readonly interactiveSessions?: InteractiveSessionsPort | undefined;
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
  
  readonly getTranscriptSnapshot?: (() => ClassicTranscriptItem[] | undefined) | undefined;
  /** When true, never persist sessions or generate AI titles (CLI --no-history). */
  readonly noHistory?: boolean | undefined;
  readonly notifyResponderDelivery?: ((summary: string) => void) | undefined;
  readonly titleCompleter?: ((messages: ChatMessage[]) => Promise<string>) | undefined;
}


export type TurnEndListener = (result: TurnResult) => void;
export type SessionStateListener = () => void;

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
  private readonly prompts: SessionPromptQueue;
  private readonly responder: SessionResponder | undefined;
  private provider: ProviderId | undefined;
  private model: string | undefined;
  private mode: Mode;
  private compactingFlag = false;
  private readonly activeCompactions = new Set<string>();
  private compactAbort: AbortController | undefined; // cancels in-flight /compact
  /** Display name written into history.db. */
  private sessionTitle: string | undefined;
  private readonly namer: SessionNamer;
  private lastMainRequestSnapshot: SuccessfulRequestSnapshot | undefined;
  /** Throttle mid-turn history autosaves so abort/crash still keep tools on disk. */
  private lastAutosaveAt = 0;
  private autosaveInFlight = false;
  /** Orders autosave, terminal, compaction, title, switch, and shutdown writes. */
  private readonly persistence: SessionPersistenceQueue;
  private static readonly AUTOSAVE_MIN_MS = 15_000;
  /** Last known versioned context measurement for the session. */
  private contextSnapshot: ContextSnapshotV1 | undefined;
  /** Avoid applying the same manual compaction in both commit and event paths. */
  private lastContextCompactionId: string | undefined;
  private readonly contextLimits = new SessionContextLimits();
  private readonly usageLedger = new SessionUsageLedger();
  /** Bumped by reset/history load/dispose so late callbacks can be ignored. */
  private lifecycleGeneration = 0;
  private lastTurnResult: TurnResult | undefined;
  private restoredPreviousTurn: PreviousTurnSignal | undefined;
  private activeTurnGeneration: number | undefined;
  private readonly projectContext = createContextProjector((snapshot) =>
    formatContextChip(snapshot, { compact: false }),
  );

  constructor(private readonly deps: SessionControllerDeps) {
    this.sessionIdValue = asSessionId(deps.sessionId ?? mintSessionId());
    this.persistence = new SessionPersistenceQueue(deps.persistence);
    this.provider = deps.provider;
    this.model = deps.model;
    this.mode = deps.mode ?? "agent";
    this.policy = createSessionPolicy(this.sessionIdValue);
    void this.deps.interactiveSessions?.activateOwner(this.sessionIdValue).catch(() => undefined);
    // Isolate scratch + tool outputs for this session immediately.
    beginSessionWorkspace();
    void prefetchProviderCatalog(this.provider);
    publishRouteReasoningVocabulary(this.provider, this.model);
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
        emit: (event) => this.observeEmit(event),
        mintTurnId: deps.mintTurnId,
      }),
    );
    this.prompts = new SessionPromptQueue({
      isRunning: () => this.turn.running,
      abort: (reason) => this.abort(reason),
      notifyState: () => this.notifyState(),
      notice: (text) => this.notice("info", text),
      runTurn: (prompt, options) => this.runTurn(prompt, options),
      lastTurnResult: () => this.lastTurnResult,
    });
    this.namer = new SessionNamer({
      complete:
        deps.titleCompleter ??
        ((messages) =>
          completeForSessionNaming(messages, {
            provider: this.provider,
            model: this.model,
          })),
      applyTitle: (title) => {
        this.sessionTitle = title;
        this.notifyState();
        void this.persistNow().catch(() => undefined);
      },
      enabled: () => !this.deps.noHistory && !getConfig().privateMode,
    });
    if (deps.jobs) {
      this.responder = new SessionResponder({
        jobs: deps.jobs,
        persistence: deps.persistence,
        sessionId: () => this.sessionIdValue,
        isBusy: () => this.turn.running || this.compactingFlag,
        hasQueuedWork: () => this.prompts.hasPending(),
        continueQueue: () => this.prompts.continue(),
        runTurn: (prompt, onStarted) =>
          this.runTurn(prompt, {
            displayPrompt: null,
            materializeHistoryImages: false,
            onStarted,
          }),
        notifyState: () => this.notifyState(),
        ...(deps.notifyResponderDelivery
          ? { notifyDelivery: deps.notifyResponderDelivery }
          : {}),
      });
      const unsubscribe = deps.jobs.subscribe((change) => {
        this.responder?.handleChange(change);
      });
      this.disposables.add({ dispose: unsubscribe });
    } else {
      this.responder = undefined;
    }
  }

  /** Current per-session scratch/output workspace (always bound while live). */
  get workspace(): SessionWorkspace | undefined {
    return getActiveSessionWorkspace();
  }

  get sessionId(): SessionId {
    return this.sessionIdValue;
  }

  getState(): SessionState {
    const { contextSnapshot, contextUsage, contextChip } =
      this.contextUsageProjection();
    return {
      sessionId: this.sessionIdValue,
      mode: this.mode,
      provider: this.provider,
      model: this.model,
      running: this.turn.running,
      compacting:
        this.compactingFlag ||
        (this.turn.running && this.activeCompactions.size > 0),
      historyLength: this.history.length,
      queued: this.prompts.snapshot(),
      responder: this.responder?.getState() ?? IDLE_RESPONDER_STATE,
      title: this.sessionTitle,
      contextSnapshot,
      contextUsage,
      contextChip,
    };
  }

  private contextUsageProjection(): ContextProjection {
    return this.projectContext(
      this.usageTarget,
      this.history,
      this.contextSnapshot,
      () => this.contextTimestamp(),
    );
  }

  private get contextLimitTokens(): number | undefined {
    return this.contextLimits.get(this.provider, this.model);
  }

  private get usageTarget(): ContextUsageTarget {
    const contextLimitTokens = this.contextLimitTokens;
    return {
      provider: this.provider,
      model: this.model,
      ...(contextLimitTokens ? { contextLimitTokens } : {}),
    };
  }

  private contextTimestamp(): number {
    return this.deps.clock?.now() ?? Date.now();
  }

  private setContextSnapshot(snapshot: ContextSnapshotV1 | undefined): void {
    this.contextSnapshot = snapshot;
  }

  private resolveContextSnapshot(): ContextSnapshotV1 | undefined {
    return resolveSnapshot(
      this.usageTarget,
      this.history,
      this.contextSnapshot,
      () => this.contextTimestamp(),
    );
  }

  /** Next-request occupancy, only when a request-scoped measurement exists. */
  private requestScopedContextTokens(): number | undefined {
    const snapshot = this.contextSnapshot;
    if (!snapshot || snapshot.contextTokens <= 0) return undefined;
    return snapshot.scope === "provider-request" ||
      snapshot.scope === "assembled-request"
      ? snapshot.contextTokens
      : undefined;
  }

  recordTokenUsage(
    usage: TokenUsage,
    model?: string,
    provider?: ProviderId,
    attempt?: ContextAttemptReference,
  ): void {
    if (provider !== undefined) this.provider = provider;
    if (model !== undefined) this.model = model;
    this.usageLedger.record(usage, this.provider, this.model);
    this.setContextSnapshot(
      recordContextUsageSnapshot(
        this.usageTarget,
        this.contextSnapshot,
        usage,
        attempt,
        () => this.contextTimestamp(),
      ),
    );
    this.notifyState();
  }

  usageReport(): SessionUsageReport {
    return this.usageLedger.report();
  }

  noteContextCompacted(
    afterTokens?: number,
    scope: "message-history" | "assembled-request" = "assembled-request",
    compactionId?: string,
  ): void {
    if (compactionId && compactionId === this.lastContextCompactionId) return;
    this.setContextSnapshot(
      compactedContextSnapshot(
        this.usageTarget,
        this.contextSnapshot,
        this.history,
        afterTokens,
        scope,
        () => this.contextTimestamp(),
      ),
    );
    if (compactionId) this.lastContextCompactionId = compactionId;
    this.notifyState();
  }

  noteContextEstimate(estimatedTokens: number): void {
    const next = estimatedContextSnapshot(
      this.usageTarget,
      this.contextSnapshot,
      estimatedTokens,
      () => this.contextTimestamp(),
    );
    if (next !== this.contextSnapshot) {
      this.setContextSnapshot(next);
      this.notifyState();
    }
  }

  private refreshEstimatedContext(): void {
    this.setContextSnapshot(
      resolveSnapshot(
        this.usageTarget,
        this.history,
        undefined,
        () => this.contextTimestamp(),
      ),
    );
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
    this.lastMainRequestSnapshot = undefined;
    this.setContextSnapshot(this.resolveContextSnapshot());
    clearTextOnlyModels();
    void prefetchProviderCatalog(provider);
    publishRouteReasoningVocabulary(provider, this.model);
    this.notifyState();
  }

  setContextLimitTokens(limit: number | undefined): void {
    this.contextLimits.set(this.provider, this.model, limit);
    this.setContextSnapshot(this.resolveContextSnapshot());
    this.notifyState();
  }

  setModel(model: string | undefined): void {
    this.model = model;
    this.lastMainRequestSnapshot = undefined;
    this.setContextSnapshot(this.resolveContextSnapshot());
    // Allow native tools again after /model switch (sticky text-only is process-global).
    clearTextOnlyModels();
    publishRouteReasoningVocabulary(this.provider, model);
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
    options: {
      sessionId?: string;
      title?: string | undefined;
      /**
       * Restored from history so the footer matches the live session count.
       * Accepts partial snapshots (contextLimit optional).
       */
      contextUsage?: ContextUsageSnapshot | PartialUsageSnapshot | undefined;
      /** Loaded durable revision; resume advances to a fresh writer generation. */
      persistenceRevision?: number | undefined;
      /** Last turn outcome or interrupted in-flight checkpoint from history. */
      previousTurn?: PreviousTurnSignal | undefined;
      /** Per-session scratch/output folder (restored with history). */
      workspaceFolder?: string | undefined;
      workspaceCode?: string | undefined;
    } = {},
  ): void {
    this.beginLifecycleGeneration();
    // Deep-copy then heal broken assistant/tool pairs from aborted turns so
    // /history resume + "continue" never dies on invalid native tool protocol.
    const healed: ChatMessage[] = messages.map((m) => ({ ...m }));
    repairToolProtocol(healed);
    this.history = healed;
    this.restoredPreviousTurn = options.previousTurn;
    this.prompts.clear();
    this.spool.clear();
    this.sessionTitle = options.title;
    this.namer.restore(options.title);
    // Prefer the exact snapshot saved during the live turn; only estimate when
    // older sessions have no usage payload (would otherwise drop 39k → ~11k).
    this.lastContextCompactionId = undefined;
    const restored = restoredContextSnapshot(
      this.usageTarget,
      options.contextUsage,
      () => this.contextTimestamp(),
    );
    this.usageLedger.restore(
      (options.contextUsage as { routeUsage?: unknown } | undefined)?.routeUsage,
    );
    if (restored) {
      this.setContextSnapshot(restored);
    } else {
      this.setContextSnapshot(undefined);
      this.refreshEstimatedContext();
    }
    if (options.sessionId) {
      const nextSessionId = asSessionId(options.sessionId);
      if (nextSessionId !== this.sessionIdValue) {
        this.fenceInteractiveOwner(this.sessionIdValue);
      }
      this.sessionIdValue = nextSessionId;
      this.sequencer.rebind(this.sessionIdValue);
      this.policy = createSessionPolicy(this.sessionIdValue);
      this.persistence.rebind(options.persistenceRevision);
      void this.deps.interactiveSessions?.activateOwner(this.sessionIdValue).catch(() => undefined);
    }
    // Rebind (or mint) the per-session workspace so scratch + outputs
    // continue under the same folder when resuming history.
    beginSessionWorkspace({
      folderName: options.workspaceFolder,
      code: options.workspaceCode,
    });
    this.settlePersistedResponderResults();
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
    this.beginLifecycleGeneration();
    this.sequencer.rebind(this.sessionIdValue);
    this.history = [];
    this.restoredPreviousTurn = undefined;
    this.prompts.clear();
    this.sessionTitle = undefined;
    this.namer.reset();
    this.setContextSnapshot(undefined);
    this.lastContextCompactionId = undefined;
    this.usageLedger.clear();
    this.spool.clear();
    if (options.mintNewId) {
      this.fenceInteractiveOwner(this.sessionIdValue);
      this.sessionIdValue = asSessionId(mintSessionId());
      this.sequencer.rebind(this.sessionIdValue);
      this.persistence.newSession();
      void this.deps.interactiveSessions?.activateOwner(this.sessionIdValue).catch(() => undefined);
      // Fresh session identity → fresh isolated workspace.
      beginSessionWorkspace();
    }
    this.policy = createSessionPolicy(this.sessionIdValue);
    this.notifyState();
  }

  /** Roll back history after a rejected plan-implement compaction. */
  restoreMessages(
    messages: readonly ChatMessage[],
    contextSnapshot?: ContextSnapshotV1 | ContextUsageSnapshot | undefined,
  ): void {
    this.history = [...messages];
    this.lastMainRequestSnapshot = undefined;
    this.lastContextCompactionId = undefined;
    const restored = restoredContextSnapshot(
      this.usageTarget,
      contextSnapshot,
      () => this.contextTimestamp(),
    );
    if (restored) {
      this.setContextSnapshot(restored);
    } else {
      this.refreshEstimatedContext();
    }
    this.notifyState();
  }

  async compact(
    sessionTranscript?: string,
    keepRecent = 2,
    signal?: AbortSignal,
    options: {
      purpose?: "default" | "plan-implement" | undefined;
      /** Default true: emit compacted event + persist. */
      persist?: boolean | undefined;
    } = {},
  ): Promise<CompactResult> {
    if (this.turn.running) throw new Error("a turn is already running");
    if (this.compactingFlag) throw new Error("compaction already in progress");

    const cfg = getConfig();
    const provider = this.provider ?? (cfg.defaultProvider as ProviderId | undefined);
    const history = [...this.history];
    const persist = options.persist !== false;
    const requestTokensBefore = this.requestScopedContextTokens();
    const generation = this.lifecycleGeneration;
    const compactionId = String(this.sequencer.ids.message());
    const abortController = new AbortController();
    this.compactingFlag = true;
    this.compactAbort = abortController;
    if (signal?.aborted) abortController.abort();
    else signal?.addEventListener("abort", () => abortController.abort(), { once: true });
    this.notifyState();

    const resumedRequest: SuccessfulRequestSnapshot | undefined =
      this.lastMainRequestSnapshot ??
      (provider !== undefined && requestTokensBefore !== undefined
        ? { provider, model: this.model ?? cfg.defaultModel, messages: history }
        : undefined);

    try {
      return await runSessionCompaction({
        history,
        sessionTranscript,
        keepRecent,
        signal: abortController.signal,
        purpose: options.purpose,
        provider,
        model: this.model ?? cfg.defaultModel,
        ...(resumedRequest ? { successfulRequest: resumedRequest } : {}),
        ...(this.contextLimitTokens
          ? { contextLimitTokens: this.contextLimitTokens }
          : {}),
        ...(requestTokensBefore !== undefined ? { requestTokensBefore } : {}),
        persist,
        compactionId,
        sequencer: this.sequencer,
        emit: this.deps.emit,
        isCurrent: () => generation === this.lifecycleGeneration,
        commit: (result, reported) => {
          this.history = result.messages;
          if (result.summarized) {
            this.lastMainRequestSnapshot = undefined;
            this.noteContextCompacted(
              reported.afterTokens,
              reported.scope,
              compactionId,
            );
          }
          this.notifyState();
        },
        persistNow: () => this.persistNow(),
      });
    } finally {
      if (generation === this.lifecycleGeneration) {
        this.compactingFlag = false;
        this.compactAbort = undefined;
      }
      this.notifyState();
      this.responder?.scheduleWake();
    }
  }

  private settlePersistedResponderResults(): void {
    settlePersistedResponderResults({
      jobs: this.deps.jobs,
      sessionId: this.sessionIdValue,
      history: this.history,
    });
  }

  private continuationCheckpoint(): PreviousTurnSignal | undefined {
    if (this.activeTurnGeneration === this.lifecycleGeneration) {
      return { status: "error", reason: "the previous process stopped before the turn settled" };
    }
    return previousTurnSignal(this.lastTurnResult) ?? this.restoredPreviousTurn;
  }

  canResumeFromHistory(): boolean {
    return (
      !this.deps.noHistory &&
      !getConfig().privateMode &&
      hasPersistableHistory(this.history)
    );
  }

  async persistNow(name?: string): Promise<void> {
    if (this.deps.noHistory || getConfig().privateMode) {
      this.settlePersistedResponderResults();
      return;
    }
    if (!hasPersistableHistory(this.history)) {
      return;
    }
    if (name) {
      this.sessionTitle = name;
      this.namer.markManual();
    }

    const contextSnapshot = this.resolveContextSnapshot();
    this.setContextSnapshot(contextSnapshot);
    const contextUsage = persistedContextUsage(
      contextSnapshot,
      this.usageLedger.persist(),
    );
    await this.persistence.save(this.history, {
      sessionId: this.sessionIdValue,
      name: name ?? this.sessionTitle,
      transcript: this.deps.getTranscriptSnapshot?.(),
      previousTurn: this.continuationCheckpoint() ?? null,
      ...(contextUsage ? { contextUsage } : {}),
    });
    this.settlePersistedResponderResults();
  }

  estimateContext(): { messages: number; tokens: number } {
    const snapshot = this.resolveContextSnapshot();
    return {
      messages: this.history.length,
      tokens: snapshot?.contextTokens ?? estimateMessagesTokens(this.history),
    };
  }

  async cancelAll(): Promise<ToolResult> {
    this.responder?.invalidateWake();
    this.prompts.preservePendingPriority();
    this.turn.abort();
    this.compactAbort?.abort();
    this.notifyState();
    const [jobs, interactive] = await Promise.all([
      this.deps.jobs?.cancelAll(this.sessionIdValue),
      this.deps.interactiveSessions?.cancelOwner(this.sessionIdValue),
    ]);
    return mergeCancelAllResult(jobs, interactive);
  }

  private fenceInteractiveOwner(ownerId: string): void {
    void this.deps.interactiveSessions
      ?.beginCloseOwner(ownerId)
      .catch(() => undefined);
  }

  enqueue(prompt: string, opts?: TurnDisplayOptions): void {
    this.namer.noteUserPrompt(opts?.displayPrompt !== null);
    this.prompts.enqueue(prompt, opts);
  }

  queued(): readonly string[] {
    return this.prompts.snapshot();
  }

  removeQueued(index: number): void {
    this.prompts.remove(index);
  }

  takeQueued(index: number): string | undefined {
    return this.prompts.take(index);
  }

  editQueued(index: number, text: string): void {
    this.prompts.edit(index, text);
  }

  reorderQueued(fromIndex: number, toIndex: number): void {
    this.prompts.reorder(fromIndex, toIndex);
  }

  sendQueuedNow(index: number): void {
    this.prompts.sendNow(index);
  }

  abort(reason?: string): void {
    this.responder?.deactivate();
    this.turn.abort(reason);
    this.compactAbort?.abort(); // also cancel in-flight /compact (outside a turn)
  }

  async continueQueue(): Promise<void> {
    await this.prompts.continue();
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

  async submit(prompt: string, opts?: TurnDisplayOptions): Promise<TurnResult> {
    this.namer.noteUserPrompt(opts?.displayPrompt !== null);
    this.responder?.activate();
    this.loopRecoveryAttempts.clear();
    return this.prompts.submit(prompt, opts);
  }

  async drain(): Promise<TurnResult[]> {
    return this.prompts.drain();
  }

  private async runTurn(
    prompt: string,
    opts?: {
      displayPrompt?: string | null | undefined;
      materializeHistoryImages?: boolean | undefined;
      onStarted?: (() => void) | undefined;
    },
  ): Promise<TurnResult> {
    const config = getConfig();
    const provider = this.provider ?? config.defaultProvider;
    const model = this.model ?? getProviderModel(provider);
    const checkpoint = this.continuationCheckpoint();
    const built = buildTurnRequest({
      prompt,
      mode: this.mode,
      provider,
      model,
      history: this.history,
      materializeImages: opts?.materializeHistoryImages !== false,
      ...(opts?.displayPrompt !== undefined
        ? { displayPrompt: opts.displayPrompt }
        : {}),
      ...(checkpoint ? { previousTurn: checkpoint } : {}),
      ...(this.lastMainRequestSnapshot
        ? { previousSuccessfulRequest: this.lastMainRequestSnapshot }
        : {}),
      ...(this.contextLimitTokens
        ? { contextLimitTokens: this.contextLimitTokens }
        : {}),
      getContextLimitTokens: (routeProvider, routeModel) =>
        this.contextLimits.get(routeProvider, routeModel),
    });
    if (built.fallbackReason) this.notice("info", built.fallbackReason);
    for (const issue of built.imageIssues) this.notice("warn", issue);
    const request = built.request;
    const turnGeneration = this.lifecycleGeneration;
    this.activeTurnGeneration = turnGeneration;
    const pending = this.turn.run(request, {
      confirm: this.deps.confirm,
      requestSecret: this.deps.requestSecret,
      session: this.policy,
      onMessages: (messages) => {
        // A later reset/load owns the session; ignore late callbacks.
        if (turnGeneration !== this.lifecycleGeneration) return;
        this.history = pathBackedMessages(messages);
        this.notifyState();
        // Periodic durable snapshot so Esc/kill mid-run does not wipe tools.
        this.scheduleAutosave();
      },
      onSuccessfulRequest: (snapshot) => {
        if (turnGeneration !== this.lifecycleGeneration) return;
        this.lastMainRequestSnapshot = snapshot;
      },
      onStarted: opts?.onStarted,
    });
    this.notifyState();
    const result = await pending;
    if (this.activeTurnGeneration === turnGeneration) {
      this.activeTurnGeneration = undefined;
    }
    this.notifyState();
    this.responder?.scheduleWake();
    const sameGeneration = turnGeneration === this.lifecycleGeneration;
    if (sameGeneration) {
      this.lastTurnResult = result;
      this.restoredPreviousTurn = undefined;
      this.maybeScheduleLoopGuardRecovery(result);
    }
    try {
      if (
        sameGeneration &&
        (result.status === "completed" ||
          result.status === "aborted" ||
          result.status === "error")
      ) {
        await this.persistNow();
      }
      if (sameGeneration) this.namer.maybeRename(this.history);
      for (const listener of this.turnEndListeners) listener(result);
      if (sameGeneration) this.prompts.settle(result);
      return result;
    } finally {
      this.responder?.scheduleWake();
    }
  }

  private readonly loopRecoveryAttempts = new Map<string, number>();

  private maybeScheduleLoopGuardRecovery(result: TurnResult): void {
    if (result.status !== "completed") return;
    const stop = result.outcome.loopGuardStop;
    if (!stop) {
      if (result.outcome.status === "succeeded") this.loopRecoveryAttempts.clear();
      return;
    }
    const signature = stop.signature || stop.calls;
    const attempts = this.loopRecoveryAttempts.get(signature) ?? 0;
    if (attempts >= 1) {
      this.notice(
        "warn",
        "Loop guard stopped the agent again after automatic recovery — leaving the turn stopped. Continue manually with a different approach.",
      );
      return;
    }
    this.loopRecoveryAttempts.set(signature, attempts + 1);
    const observation = stop.observation?.trim()
      ? stop.observation.trim()
      : "(no captured output — the repeated calls were blocked before running again)";
    const prompt = [
      `[LOOP GUARD RECOVERY] Your previous turn was stopped automatically because you repeated the exact same action sequence (same tools, same arguments) across consecutive responses: ${stop.calls}.`,
      "",
      "Those calls already ran and their results are available — re-issuing them is a loop.",
      "",
      "Earlier output of the repeated calls:",
      observation,
      "",
      "Continue efficiently from these results. Do NOT re-issue the same calls with the same arguments; use the output above or take a materially different action to finish the remaining work.",
    ].join("\n");
    this.notice(
      "warn",
      "Loop guard stopped a repeated action cycle — auto-recovering with the captured results.",
    );
    this.prompts.enqueuePriority(
      prompt,
      "↻ auto-recovery: loop guard stopped a repeated action cycle",
    );
  }

  /**
   * Best-effort mid-turn autosave (throttled). Called from onMessages so a
   * long agent run still lands tools/messages on disk before abort/crash.
   */
  private scheduleAutosave(): void {
    if (this.deps.noHistory || getConfig().privateMode) return;
    if (!hasPersistableHistory(this.history)) return;
    const now = Date.now();
    if (now - this.lastAutosaveAt < SessionController.AUTOSAVE_MIN_MS) return;
    if (this.autosaveInFlight) return;
    this.lastAutosaveAt = now;
    this.autosaveInFlight = true;
    void this.persistNow()
      .catch(() => undefined)
      .finally(() => {
        this.autosaveInFlight = false;
      });
  }

  /** Fence the previous lifecycle: running turn, compaction and title. */
  private beginLifecycleGeneration(): void {
    this.lifecycleGeneration += 1;
    this.lastTurnResult = undefined;
    this.restoredPreviousTurn = undefined;
    this.lastMainRequestSnapshot = undefined;
    this.loopRecoveryAttempts.clear();
    if (this.turn.running) this.turn.abort();
    this.compactAbort?.abort();
    this.compactAbort = undefined;
    this.compactingFlag = false;
    this.activeCompactions.clear();
    this.responder?.invalidateWake();
  }

  dispose(): void {
    this.beginLifecycleGeneration();
    this.fenceInteractiveOwner(this.sessionIdValue);
    this.turnEndListeners.clear();
    this.stateListeners.clear();
    this.disposables.dispose();
  }

  private notifyState(): void {
    for (const listener of this.stateListeners) listener();
  }

  private observeEmit(event: AnyAppEvent): void {
    if (event.type === "compaction-started") {
      this.activeCompactions.add(event.payload.compactionId);
      this.notifyState();
    } else if (
      event.type === "compaction-completed" ||
      event.type === "compaction-failed"
    ) {
      if (this.activeCompactions.delete(event.payload.compactionId)) {
        this.notifyState();
      }
    } else if (
      event.type === "turn-ended" ||
      event.type === "turn-aborted" ||
      event.type === "turn-error"
    ) {
      if (this.activeCompactions.size > 0) {
        this.activeCompactions.clear();
        this.notifyState();
      }
    }
    this.deps.emit(event);
  }
}
