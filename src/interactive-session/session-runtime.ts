
import type { BoundedArtifactWriter } from "./artifact-writer.js";
import type { InteractiveSessionConfig } from "./config.js";
import type { OutputStore } from "./output-store.js";
import type { InteractiveEngagementState } from "../safety/engagement-policy.js";
import {
  AsyncMutex,
  FinalizeOnce,
  Notifier,
  OrderedInputQueue,
  TimerSet,
  type Clock,
} from "./runtime.js";
import type { SessionTransport } from "./transport.js";
import type {
  CloseResult,
  InteractiveSessionRecord,
  TerminationReason,
} from "./types.js";

export interface SessionRuntimeInit {
  readonly record: InteractiveSessionRecord;
  readonly transport: SessionTransport;
  readonly output: OutputStore;
  readonly artifact: BoundedArtifactWriter;
  readonly config: InteractiveSessionConfig;
  readonly clock: Clock;
  readonly idleTimeoutMs: number | undefined;
  readonly lifetimeTimeoutMs: number | undefined;
  readonly engagementState?: InteractiveEngagementState | undefined;
  readonly onTimeout: (reason: "idle-timeout" | "lifetime-timeout") => void;
}

export class SessionRuntime {
  readonly record: InteractiveSessionRecord;
  readonly transport: SessionTransport;
  readonly output: OutputStore;
  readonly artifact: BoundedArtifactWriter;
  readonly config: InteractiveSessionConfig;
  readonly clock: Clock;
  readonly input = new OrderedInputQueue();
  readonly mutation = new AsyncMutex();
  readonly policy = new AsyncMutex();
  readonly finalize = new FinalizeOnce<CloseResult>();
  readonly timers: TimerSet;
  readonly exitSignal = new Notifier();
  engagementState: InteractiveEngagementState;

  processExited = false;
  exitObserved: TerminationReason | undefined;
  disposed = false;

  private readonly unsubscribes: Array<() => void> = [];
  private readonly idleTimeoutMs: number | undefined;

  constructor(init: SessionRuntimeInit) {
    this.record = init.record;
    this.transport = init.transport;
    this.output = init.output;
    this.artifact = init.artifact;
    this.config = init.config;
    this.clock = init.clock;
    this.engagementState = init.engagementState ?? {};
    this.idleTimeoutMs = init.idleTimeoutMs;
    this.timers = new TimerSet(init.clock, init.onTimeout);
    this.timers.armIdle(init.idleTimeoutMs);
    this.timers.armLifetime(init.lifetimeTimeoutMs);
  }

  track(unsubscribe: () => void): void {
    this.unsubscribes.push(unsubscribe);
  }

  touch(): void {
    this.record.lastActivityAt = Date.now();
    this.timers.armIdle(this.idleTimeoutMs);
  }

  syncCursors(): void {
    this.record.earliestCursor = this.output.earliestCursor;
    this.record.latestCursor = this.output.latestCursor;
  }

  releaseListeners(): void {
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      try {
        unsubscribe();
      } catch {
      }
    }
  }
}
