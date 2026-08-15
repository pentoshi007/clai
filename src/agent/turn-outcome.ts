export type TurnOutcomeStatus =
  | "succeeded"
  | "partial"
  | "blocked"
  | "failed"
  | "aborted"
  | "paused_budget";

export interface LoopGuardStopInfo {
  readonly calls: string;
  readonly observation?: string | undefined;
  readonly signature: string;
}

export interface TurnOutcome {
  readonly schemaVersion: 1;
  readonly status: TurnOutcomeStatus;
  readonly answer: string;
  readonly steps: number;
  readonly remainingCriteria: readonly string[];
  readonly reason?: string | undefined;
  readonly loopGuardStop?: LoopGuardStopInfo | undefined;
}

export function normalizeTurnOutcomeInput(
  input: Omit<TurnOutcome, "schemaVersion">,
): Omit<TurnOutcome, "schemaVersion"> {
  if (input.status !== "succeeded" || input.remainingCriteria.length === 0) {
    return input;
  }
  const claimsCompletion =
    /\b(?:all\s+(?:tasks?|work|done|complete)|everything\s+is\s+done|fully\s+(?:implemented|fixed|resolved)|fix\s+(?:is\s+)?(?:complete|verified)|work\s+is\s+(?:done|complete)|successfully\s+(?:implemented|fixed|completed|verified))\b/i.test(
      input.answer,
    );
  if (claimsCompletion) return input;
  return {
    ...input,
    status: "partial",
    reason:
      input.reason ??
      "Required outcome criteria remain incomplete despite a success signal.",
  };
}

export function createTurnOutcome(input: Omit<TurnOutcome, "schemaVersion">): TurnOutcome {
  if (input.status === "succeeded" && input.remainingCriteria.length > 0) {
    throw new Error("a succeeded turn cannot have remaining criteria");
  }
  return { schemaVersion: 1, ...input };
}

export function renderTurnOutcome(
  outcome: TurnOutcome,
  _options: { diagnostics?: boolean } = {},
): string {
  return outcome.answer;
}
