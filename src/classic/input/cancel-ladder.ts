import type { CancelCoordinator } from "../../app/controllers/cancel-coordinator.js";
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

export interface CancelLadderDeps {
  readonly coordinator: CancelCoordinator;
  readonly overlay: { cancelBlockingPrompt(): boolean };
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
    if (this.quitArmed) {
      this.deps.requestExit();
      return;
    }
    this.lastCtrlCAt = this.now();
    const active = dismissed || this.deps.coordinator.hasCancelableWork();
    void this.deps.coordinator.cancelAll().then(
      (outcome) => { if (!outcome.ok) this.notifyCancellationFailure(); },
      () => this.notifyCancellationFailure(),
    );
    this.deps.notify({
      level: active ? "warn" : "info",
      text: active ? "Cancelling work · Ctrl+C again to exit" : "Ctrl+C again to exit",
      key: "interrupt",
      durationMs: 2200,
    });
  }

  private notifyCancellationFailure(): void {
    this.deps.notify({
      level: "warn",
      text: "Cancellation completed with job stop failures — open Jobs for details",
      key: "interrupt-failed",
      durationMs: 3200,
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

    if (doublePress && this.deps.coordinator.hasForegroundWork()) {
      this.lastEscapeAt = 0;
      this.deps.overlay.cancelBlockingPrompt();
      this.deps.coordinator.abortForeground();
      this.deps.notify({
        level: "info",
        text: "Main agent stopped · Background work continues",
        key: "escape-foreground",
        durationMs: 2400,
      });
      return;
    }

    if (this.deps.coordinator.hasForegroundWork()) {
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
}
