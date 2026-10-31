import { classifyGoalFailure, type GoalFailure } from "../../agent/goal/goal-failure.js";
import {
  goalCheckInPrompt,
  goalContinuationPrompt,
  goalKickoffPrompt,
  goalRetryPrompt,
  MAX_GOAL_OBJECTIVE_CHARS,
  normalizeGoalObjective,
} from "../../agent/goal/goal-prompts.js";
import type { GoalVerdict } from "../../agent/goal/goal-verdict.js";
import type { Mode } from "../../types.js";
import type { PersistedGoal, PersistedGoalPause } from "../ports/persistence-port.js";
import type {
  GoalPhase,
  GoalReport,
  GoalSetResult,
  GoalStatus,
  GoalUpdate,
  GoalView,
} from "./goal-types.js";
import type { TurnResult } from "./turn-controller.js";

export const GOAL_MAX_STALLS = 3;
export const GOAL_MAX_AUTOMATIC_TURNS = 50;
export const GOAL_RETRY_DELAYS_MS: readonly number[] = [15_000, 30_000, 60_000];
export const GOAL_CHECK_IN_MS = 30 * 60_000;
export const GOAL_MAX_CHECK_IN_MS = GOAL_CHECK_IN_MS * 4;
export const GOAL_MAX_IDLE_CHECK_INS = 3;

export interface GoalBackgroundWork {
  readonly running: readonly string[];
  readonly pendingDeliveries: number;
}

export interface GoalTimers {
  set(callback: () => void, delayMs: number): () => void;
}

export interface GoalTurnOptions {
  readonly displayPrompt: string | null;
  readonly kickoff: boolean;
}

export interface SessionGoalDeps {
  readonly now: () => number;
  readonly mintId: () => string;
  readonly isBusy: () => boolean;
  readonly hasQueuedWork: () => boolean;
  readonly mode: () => Mode;
  readonly background: () => GoalBackgroundWork;
  readonly tokens: () => number;
  readonly evaluate: (objective: string, signal: AbortSignal) => Promise<GoalVerdict | undefined>;
  readonly runTurn: (prompt: string, options: GoalTurnOptions) => Promise<TurnResult>;
  readonly load: () => PersistedGoal | undefined;
  readonly save: (goal: PersistedGoal | undefined) => void;
  readonly emit: (update: GoalUpdate) => void;
  readonly notifyState: () => void;
  readonly idle: () => void;
  readonly timers?: GoalTimers | undefined;
}

type AbortCause = "prompt" | "interrupt" | "lifecycle";

interface GoalRetry {
  readonly at: number;
  readonly source: "turn" | "evaluation";
  readonly cause: string;
}

interface GoalRecord {
  readonly id: string;
  readonly objective: string;
  readonly createdAt: number;
  readonly startedAt: number;
  readonly tokenBaseline: number;
  status: GoalStatus;
  pause: PersistedGoalPause | undefined;
  turns: number;
  automaticTurns: number;
  stalls: number;
  lastReason: string | undefined;
  kickoffPending: boolean;
  evaluationDue: boolean;
  toolsSinceEvaluation: boolean;
  retries: number;
  retry: GoalRetry | undefined;
  waitingFor: readonly string[] | undefined;
  checkInAt: number | undefined;
  checkInIntervalMs: number;
  idleCheckIns: number;
}

interface Evaluation {
  readonly goal: GoalRecord;
  readonly controller: AbortController;
  cause: AbortCause | undefined;
}

const systemTimers: GoalTimers = {
  set(callback, delayMs) {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

const INTERRUPTED = "interrupted";

export class SessionGoal {
  private goal: GoalRecord | undefined;
  private achieved: GoalReport | undefined;
  private evaluation: Evaluation | undefined;
  private wake: Promise<void> | undefined;
  private wakeRequested = false;
  private cancelTimer: (() => void) | undefined;
  private toolCalls = 0;
  private interrupted = false;
  private generation = 0;
  private disposed = false;

  constructor(private readonly deps: SessionGoalDeps) {}

  get evaluating(): boolean {
    return this.evaluation !== undefined;
  }

  view(): GoalView | undefined {
    const goal = this.goal;
    if (!goal) return undefined;
    const phase = this.phaseOf(goal);
    return {
      id: goal.id,
      objective: goal.objective,
      status: goal.status,
      startedAt: goal.startedAt,
      turns: goal.turns,
      ...(phase ? { phase } : {}),
      ...(goal.lastReason ? { lastReason: goal.lastReason } : {}),
      ...(goal.pause ? { pauseReason: goal.pause.reason, resumeOnPrompt: goal.pause.resumeOnPrompt } : {}),
      ...(phase === "retrying" && goal.retry ? { retryAt: goal.retry.at } : {}),
      ...(phase === "waiting" && goal.waitingFor ? { waitingFor: goal.waitingFor } : {}),
    };
  }

  report(): GoalReport | undefined {
    const goal = this.goal;
    if (!goal) return this.achieved;
    const phase = this.phaseOf(goal);
    return {
      objective: goal.objective,
      status: goal.status,
      durationMs: Math.max(0, this.deps.now() - goal.startedAt),
      turns: goal.turns,
      tokens: this.spent(goal),
      ...(phase ? { phase } : {}),
      ...(goal.lastReason ? { lastReason: goal.lastReason } : {}),
      ...(goal.pause ? { pauseReason: goal.pause.reason, resumeOnPrompt: goal.pause.resumeOnPrompt } : {}),
    };
  }

  set(raw: string): GoalSetResult {
    const objective = normalizeGoalObjective(raw);
    if (!objective) return { ok: false, error: "Usage: /goal <condition>" };
    if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
      return {
        ok: false,
        error: `The goal condition is ${objective.length.toLocaleString("en-US")} characters; the limit is ${MAX_GOAL_OBJECTIVE_CHARS.toLocaleString("en-US")}.`,
      };
    }
    const previous = this.goal;
    this.stopWork("lifecycle");
    if (previous) this.deps.emit({ kind: "replaced", objective: previous.objective });
    this.goal = this.record({ id: this.deps.mintId(), objective, status: "active", createdAt: this.deps.now() }, true);
    this.achieved = undefined;
    this.persist();
    this.changed();
    const deferred = this.deps.isBusy() || this.deps.hasQueuedWork();
    this.scheduleWake();
    return { ok: true, objective, deferred, ...(previous ? { replaced: previous.objective } : {}) };
  }

  pause(): GoalView | undefined {
    const goal = this.goal;
    if (!goal) return undefined;
    if (goal.status === "paused" && goal.pause?.resumeOnPrompt === false) return this.view();
    this.stopWork("lifecycle");
    this.hold(goal, "you ran /goal pause", false);
    return this.view();
  }

  resume(): GoalView | undefined {
    const goal = this.goal;
    if (!goal) return undefined;
    if (goal.status === "paused") {
      this.activate(goal);
      goal.evaluationDue = !goal.kickoffPending;
      this.persist();
      this.deps.emit({ kind: "resumed", objective: goal.objective });
      this.changed();
    } else if (!goal.kickoffPending && !goal.retry && !this.evaluation) {
      goal.evaluationDue = true;
    }
    this.scheduleWake();
    return this.view();
  }

  clear(): string | undefined {
    const goal = this.goal;
    if (!goal) return undefined;
    this.stopWork("lifecycle");
    this.goal = undefined;
    this.persist();
    this.deps.emit({ kind: "cleared", objective: goal.objective });
    this.changed();
    return goal.objective;
  }

  noteUserPrompt(): void {
    const goal = this.goal;
    if (!goal) return;
    if (this.evaluation) this.abortEvaluation("prompt");
    this.cancelTimer?.();
    goal.retry = undefined;
    goal.retries = 0;
    goal.stalls = 0;
    goal.automaticTurns = 0;
    goal.idleCheckIns = 0;
    if (goal.status === "paused" && goal.pause?.resumeOnPrompt) {
      this.activate(goal);
      this.persist();
      this.deps.emit({ kind: "resumed", objective: goal.objective });
    }
    this.changed();
  }

  noteTurnStarted(): void {
    this.toolCalls = 0;
  }

  noteToolCall(): void {
    this.toolCalls += 1;
  }

  handleTurnEnd(result: TurnResult): void {
    const usedTools = this.toolCalls > 0;
    const interrupted = this.interrupted;
    this.toolCalls = 0;
    this.interrupted = false;
    const goal = this.goal;
    if (!goal || goal.status !== "active") return;
    if (usedTools) goal.toolsSinceEvaluation = true;
    const succeeded = result.status === "completed" && result.outcome.status !== "aborted";
    if (goal.kickoffPending) {
      if (!succeeded) this.hold(goal, result.status === "error" ? classifyGoalFailure(result.error).cause : INTERRUPTED, true);
      return;
    }
    if (succeeded) {
      goal.retries = 0;
      goal.evaluationDue = true;
      return;
    }
    if (result.status === "error") {
      this.fail(goal, classifyGoalFailure(result.error), "turn");
      return;
    }
    if (interrupted || !this.deps.hasQueuedWork()) this.hold(goal, INTERRUPTED, true);
  }

  interrupt(turnRunning: boolean): void {
    const goal = this.goal;
    if (!goal || goal.status !== "active") return;
    if (this.evaluation) {
      this.abortEvaluation("interrupt");
      return;
    }
    if (goal.retry) {
      this.hold(goal, INTERRUPTED, true);
      return;
    }
    if (turnRunning) this.interrupted = true;
  }

  scheduleWake(): void {
    if (this.disposed || this.goal?.status !== "active") return;
    this.wakeRequested = true;
    if (this.wake || this.evaluation) return;
    const generation = this.generation;
    const wake = Promise.resolve()
      .then(() => this.drain(generation))
      .catch((error: unknown) => this.recover(generation, error))
      .finally(() => {
        if (this.wake !== wake) return;
        this.wake = undefined;
        if (this.wakeRequested) this.scheduleWake();
      });
    this.wake = wake;
  }

  restore(): void {
    this.reset();
    const persisted = this.deps.load();
    if (!persisted) return;
    this.goal = this.record(persisted, false);
    this.changed();
  }

  halt(): void {
    this.generation += 1;
    this.stopWork("lifecycle");
    this.wake = undefined;
    this.wakeRequested = false;
    this.interrupted = false;
  }

  reset(): void {
    this.halt();
    this.goal = undefined;
    this.achieved = undefined;
    this.toolCalls = 0;
    this.changed();
  }

  dispose(): void {
    this.halt();
    this.goal = undefined;
    this.achieved = undefined;
    this.disposed = true;
  }

  private async drain(generation: number): Promise<void> {
    this.wakeRequested = false;
    const goal = this.goal;
    if (!this.current(goal, generation)) return;
    if (this.deps.isBusy() || this.deps.hasQueuedWork()) return;
    if (goal.retry) {
      if (this.deps.now() < goal.retry.at) {
        this.timerAt(goal.retry.at);
        return;
      }
      const retry = goal.retry;
      goal.retry = undefined;
      if (retry.source === "turn") {
        await this.runGoalTurn(goal, goalRetryPrompt(goal.objective, retry.cause));
        return;
      }
      goal.evaluationDue = true;
    }
    if (goal.kickoffPending) {
      goal.kickoffPending = false;
      await this.runGoalTurn(goal, goalKickoffPrompt(goal.objective), `/goal ${goal.objective}`, true);
      return;
    }
    if (!goal.evaluationDue) return;
    if (this.deps.mode() === "plan") {
      this.markWaiting(goal, ["plan mode"]);
      return;
    }
    const background = this.deps.background();
    if (background.pendingDeliveries > 0) return;
    if (background.running.length > 0) {
      await this.waitForBackground(goal, background.running);
      return;
    }
    this.settleWaiting(goal);
    await this.evaluate(goal, generation);
  }

  private async evaluate(goal: GoalRecord, generation: number): Promise<void> {
    goal.evaluationDue = false;
    const progressed = goal.toolsSinceEvaluation;
    goal.toolsSinceEvaluation = false;
    const evaluation: Evaluation = { goal, controller: new AbortController(), cause: undefined };
    this.evaluation = evaluation;
    this.changed();
    let verdict: GoalVerdict | undefined;
    let failure: unknown;
    let failed = false;
    try {
      verdict = await this.deps.evaluate(goal.objective, evaluation.controller.signal);
    } catch (error) {
      failure = error;
      failed = true;
    }
    if (this.evaluation === evaluation) this.evaluation = undefined;
    this.changed();
    if (!this.current(goal, generation) || evaluation.cause === "lifecycle") {
      this.deps.idle();
      return;
    }
    if (evaluation.cause === "prompt") {
      goal.evaluationDue = true;
      goal.toolsSinceEvaluation ||= progressed;
      return;
    }
    if (evaluation.cause === "interrupt") {
      this.hold(goal, INTERRUPTED, true);
      this.deps.idle();
      return;
    }
    if (failed) {
      goal.toolsSinceEvaluation ||= progressed;
      this.fail(goal, classifyGoalFailure(failure), "evaluation");
      this.deps.idle();
      return;
    }
    goal.turns += 1;
    goal.retries = 0;
    if (verdict?.kind === "not_met") {
      await this.continueGoal(goal, verdict, progressed);
      return;
    }
    this.conclude(goal, verdict);
    this.deps.idle();
  }

  private conclude(goal: GoalRecord, verdict: GoalVerdict | undefined): void {
    if (!verdict) {
      this.hold(goal, "the evaluator returned no usable verdict", true);
      return;
    }
    goal.lastReason = verdict.reason;
    if (verdict.kind === "met") this.finish(goal, "achieved", verdict.reason);
    else if (verdict.kind === "impossible") this.finish(goal, "failed", verdict.reason);
    else this.hold(goal, verdict.reason, true);
  }

  private async continueGoal(goal: GoalRecord, verdict: GoalVerdict, progressed: boolean): Promise<void> {
    goal.lastReason = verdict.reason;
    goal.stalls = progressed ? 0 : goal.stalls + 1;
    if (goal.stalls >= GOAL_MAX_STALLS) {
      this.hold(goal, `no progress: ${GOAL_MAX_STALLS} turns in a row made no tool calls`, true);
      this.deps.idle();
      return;
    }
    if (goal.automaticTurns >= GOAL_MAX_AUTOMATIC_TURNS) {
      this.hold(goal, `reached ${GOAL_MAX_AUTOMATIC_TURNS} automatic turns`, true);
      this.deps.idle();
      return;
    }
    if (this.deps.isBusy() || this.deps.hasQueuedWork()) {
      goal.evaluationDue = true;
      return;
    }
    this.deps.emit({ kind: "continuing", objective: goal.objective, reason: verdict.reason, turns: goal.turns });
    await this.runGoalTurn(
      goal,
      goalContinuationPrompt(goal.objective, { reason: verdict.reason, nextStep: verdict.nextStep }),
    );
  }

  private async waitForBackground(goal: GoalRecord, running: readonly string[]): Promise<void> {
    this.markWaiting(goal, running);
    const now = this.deps.now();
    const checkInAt = goal.checkInAt ?? now + goal.checkInIntervalMs;
    goal.checkInAt = checkInAt;
    if (goal.idleCheckIns >= GOAL_MAX_IDLE_CHECK_INS) return;
    if (now < checkInAt) {
      this.timerAt(checkInAt);
      return;
    }
    goal.idleCheckIns += 1;
    goal.checkInIntervalMs = Math.min(goal.checkInIntervalMs * 2, GOAL_MAX_CHECK_IN_MS);
    goal.checkInAt = now + goal.checkInIntervalMs;
    await this.runGoalTurn(goal, goalCheckInPrompt(goal.objective, running, goal.idleCheckIns === GOAL_MAX_IDLE_CHECK_INS));
  }

  private markWaiting(goal: GoalRecord, waitingFor: readonly string[]): void {
    const first = goal.waitingFor === undefined;
    const changed = first || goal.waitingFor!.join("\n") !== waitingFor.join("\n");
    goal.waitingFor = [...waitingFor];
    if (first) this.deps.emit({ kind: "waiting", objective: goal.objective, reason: waitingFor.join(", ") });
    if (changed) this.changed();
  }

  private settleWaiting(goal: GoalRecord): void {
    if (goal.waitingFor === undefined && goal.checkInAt === undefined) return;
    goal.waitingFor = undefined;
    goal.checkInAt = undefined;
    goal.checkInIntervalMs = GOAL_CHECK_IN_MS;
    this.changed();
  }

  private async runGoalTurn(goal: GoalRecord, prompt: string, displayPrompt: string | null = null, kickoff = false): Promise<void> {
    if (!kickoff) goal.automaticTurns += 1;
    this.changed();
    await this.deps.runTurn(prompt, { displayPrompt, kickoff });
  }

  private fail(goal: GoalRecord, failure: GoalFailure, source: GoalRetry["source"]): void {
    if (failure.kind === "aborted") {
      this.hold(goal, INTERRUPTED, true);
      return;
    }
    if (failure.kind === "unrecoverable") {
      this.drop(goal, failure.cause);
      return;
    }
    if (failure.kind === "limited") {
      this.hold(goal, failure.cause, true);
      return;
    }
    const delayMs = GOAL_RETRY_DELAYS_MS[goal.retries];
    if (delayMs === undefined) {
      this.hold(goal, `${failure.cause} (after ${goal.retries} automatic retries)`, true);
      return;
    }
    goal.retries += 1;
    goal.retry = { at: this.deps.now() + delayMs, source, cause: failure.cause };
    this.deps.emit({ kind: "retrying", objective: goal.objective, reason: failure.cause, delayMs });
    this.timerAt(goal.retry.at);
    this.changed();
  }

  private recover(generation: number, error: unknown): void {
    const goal = this.goal;
    if (!this.current(goal, generation)) return;
    this.fail(goal, classifyGoalFailure(error), "turn");
  }

  private hold(goal: GoalRecord, reason: string, resumeOnPrompt: boolean): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    goal.status = "paused";
    goal.pause = { reason, resumeOnPrompt };
    goal.retry = undefined;
    goal.waitingFor = undefined;
    goal.checkInAt = undefined;
    this.persist();
    this.deps.emit({ kind: "paused", objective: goal.objective, reason, resumeOnPrompt });
    this.changed();
  }

  private drop(goal: GoalRecord, cause: string): void {
    this.stopWork("lifecycle");
    this.goal = undefined;
    this.persist();
    this.deps.emit({ kind: "unrecoverable", objective: goal.objective, reason: cause });
    this.changed();
  }

  private finish(goal: GoalRecord, outcome: "achieved" | "failed", reason: string): void {
    const durationMs = Math.max(0, this.deps.now() - goal.startedAt);
    const tokens = this.spent(goal);
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.goal = undefined;
    if (outcome === "achieved") {
      this.achieved = { objective: goal.objective, status: "achieved", durationMs, turns: goal.turns, tokens, lastReason: reason };
    }
    this.persist();
    this.deps.emit({ kind: outcome, objective: goal.objective, reason, turns: goal.turns, durationMs, tokens });
    this.changed();
  }

  private activate(goal: GoalRecord): void {
    goal.status = "active";
    goal.pause = undefined;
    goal.stalls = 0;
    goal.automaticTurns = 0;
    goal.retries = 0;
    goal.retry = undefined;
    goal.idleCheckIns = 0;
  }

  private abortEvaluation(cause: AbortCause): void {
    const evaluation = this.evaluation;
    if (!evaluation) return;
    evaluation.cause = cause;
    evaluation.controller.abort();
  }

  private stopWork(cause: AbortCause): void {
    this.abortEvaluation(cause);
    this.evaluation = undefined;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  private timerAt(at: number): void {
    this.cancelTimer?.();
    const generation = this.generation;
    this.cancelTimer = (this.deps.timers ?? systemTimers).set(() => {
      this.cancelTimer = undefined;
      if (generation === this.generation) this.scheduleWake();
    }, at - this.deps.now());
  }

  private current(goal: GoalRecord | undefined, generation: number): goal is GoalRecord {
    return generation === this.generation && goal !== undefined && goal === this.goal && goal.status === "active";
  }

  private phaseOf(goal: GoalRecord): GoalPhase | undefined {
    if (goal.status !== "active") return undefined;
    if (this.evaluation?.goal === goal) return "evaluating";
    if (goal.retry) return "retrying";
    if (goal.waitingFor) return "waiting";
    return undefined;
  }

  private spent(goal: GoalRecord): number {
    return Math.max(0, this.deps.tokens() - goal.tokenBaseline);
  }

  private record(source: PersistedGoal, kickoff: boolean): GoalRecord {
    return {
      id: source.id,
      objective: source.objective,
      createdAt: source.createdAt,
      startedAt: this.deps.now(),
      tokenBaseline: this.deps.tokens(),
      status: source.status,
      pause: source.status === "paused" ? source.pause ?? { reason: "paused", resumeOnPrompt: true } : undefined,
      turns: 0,
      automaticTurns: 0,
      stalls: 0,
      lastReason: undefined,
      kickoffPending: kickoff,
      evaluationDue: false,
      toolsSinceEvaluation: false,
      retries: 0,
      retry: undefined,
      waitingFor: undefined,
      checkInAt: undefined,
      checkInIntervalMs: GOAL_CHECK_IN_MS,
      idleCheckIns: 0,
    };
  }

  private persist(): void {
    const goal = this.goal;
    this.deps.save(goal
      ? {
          id: goal.id,
          objective: goal.objective,
          status: goal.status,
          createdAt: goal.createdAt,
          ...(goal.status === "paused" && goal.pause ? { pause: goal.pause } : {}),
        }
      : undefined);
  }

  private changed(): void {
    this.deps.notifyState();
  }
}
