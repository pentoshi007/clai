import type { TurnResult } from "./turn-controller.js";

interface SessionLoopRecoveryDeps {
  readonly notice: (text: string) => void;
  readonly enqueue: (prompt: string, label: string) => void;
}

export class SessionLoopRecovery {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly deps: SessionLoopRecoveryDeps) {}

  clear(): void {
    this.attempts.clear();
  }

  handle(result: TurnResult): void {
    if (result.status !== "completed") return;
    const stop = result.outcome.loopGuardStop;
    if (!stop) {
      if (result.outcome.status === "succeeded") this.clear();
      return;
    }
    const signature = stop.signature || stop.calls;
    const attempts = this.attempts.get(signature) ?? 0;
    if (attempts >= 1) {
      this.deps.notice(
        "Loop guard stopped the agent again after automatic recovery — leaving the turn stopped. Continue manually with a different approach.",
      );
      return;
    }
    this.attempts.set(signature, attempts + 1);
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
    this.deps.notice(
      "Loop guard stopped a repeated action cycle — auto-recovering with the captured results.",
    );
    this.deps.enqueue(
      prompt,
      "↻ auto-recovery: loop guard stopped a repeated action cycle",
    );
  }
}
