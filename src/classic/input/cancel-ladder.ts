import {
  CTRL_C_QUIT_WINDOW_MS,
  ESC_CANCEL_WINDOW_MS,
  ESC_SAME_PRESS_MS,
} from "./terminal-sequences.js";

export interface CancelLadderNotice {
  readonly level: "info" | "warn";
  readonly text: string;
  readonly key: string;
  readonly durationMs: number;
}

export interface CancelLadderSession {
  readonly sessionId: string;
  getState(): {
    readonly running: boolean;
    readonly compacting: boolean;
    readonly queued: readonly string[];
  };
  abort(): void;
  cancelAll(): Promise<{ readonly ok: boolean }>;
}

export interface CancelLadderJobs {
  running(sessionId: string): readonly unknown[];
  pendingNotifications(sessionId: string): readonly unknown[];
}

export interface CancelLadderDeps {
  readonly session: CancelLadderSession;
  readonly overlay: { cancelBlockingPrompt(): boolean };
  readonly jobs: CancelLadderJobs;
  readonly notify: (notice: CancelLadderNotice) => void;
  readonly requestExit: () => void;
  readonly now?: (() => number) | undefined;
}

export class CancelLadder {
  private lastCtrlCAt = 0;
  private lastEscapeAt = 0;
  private lastEscapeHandledAt = 0;
  private readonly now: () => number;

  constructor(private readonly deps: CancelLadderDeps) {
    this.now = deps.now ?? Date.now;
  }

  get escapeArmed(): boolean {
    return (
      this.lastEscapeAt > 0 && this.now() - this.lastEscapeAt < ESC_CANCEL_WINDOW_MS
    );
  }

  get quitArmed(): boolean {
    return (
      this.lastCtrlCAt > 0 && this.now() - this.lastCtrlCAt < CTRL_C_QUIT_WINDOW_MS
    );
  }

  clear(): void {
    this.lastEscapeAt = 0;
    this.lastCtrlCAt = 0;
  }

  disarmEscape(): void {
    this.lastEscapeAt = 0;
  }

  interrupt(): void {
    const dismissed = this.deps.overlay.cancelBlockingPrompt();
    const doublePress = this.quitArmed;
    const running = this.deps.session.getState().running;
    if (running) this.deps.session.abort();
    if (doublePress) {
      this.deps.requestExit();
      return;
    }
    this.lastCtrlCAt = this.now();
    this.deps.notify({
      level: running || dismissed ? "warn" : "info",
      text: dismissed
        ? "Prompt cancelled · Ctrl+C again to exit"
        : running
          ? "Turn aborted · Ctrl+C again to exit"
          : "Ctrl+C again to exit",
      key: "interrupt",
      durationMs: 2200,
    });
  }

  escape(dismissed: boolean): void {
    const now = this.now();
    if (
      this.lastEscapeHandledAt > 0 &&
      now - this.lastEscapeHandledAt < ESC_SAME_PRESS_MS
    ) {
      return;
    }
    this.lastEscapeHandledAt = now;
    const doublePress =
      this.lastEscapeAt > 0 && now - this.lastEscapeAt < ESC_CANCEL_WINDOW_MS;

    if (doublePress && this.hasCancelableWork()) {
      this.lastEscapeAt = 0;
      this.deps.overlay.cancelBlockingPrompt();
      void this.deps.session.cancelAll().then((result) => {
        this.lastEscapeAt = 0;
        this.deps.notify({
          level: result.ok ? "info" : "warn",
          text: result.ok
            ? "Cancelled turn and Responder jobs"
            : "Cancellation completed with job stop failures — open Jobs for details",
          key: "escape-cancel-all",
          durationMs: result.ok ? 2400 : 3200,
        });
      });
      return;
    }

    if (this.hasCancelableWork()) {
      this.lastEscapeAt = now;
      this.deps.notify({
        level: "info",
        text: "esc again to cancel",
        key: "escape-arm",
        durationMs: ESC_CANCEL_WINDOW_MS,
      });
      return;
    }

    this.lastEscapeAt = 0;
    if (dismissed) {
      this.deps.notify({
        level: "info",
        text: "Closed · Esc",
        key: "escape-dismiss",
        durationMs: 1000,
      });
    }
  }

  private hasCancelableWork(): boolean {
    const state = this.deps.session.getState();
    const sessionId = this.deps.session.sessionId;
    return (
      state.running ||
      state.compacting ||
      this.deps.jobs.running(sessionId).length > 0 ||
      this.deps.jobs.pendingNotifications(sessionId).length > 0
    );
  }
}
