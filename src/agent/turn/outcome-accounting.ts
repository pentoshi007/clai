import type { ChatMessage, ToolCall, ToolResult } from "../../types.js";
import type { OutcomeEnvelope } from "../outcomes.js";
import {
  recordFailedHypothesis,
  recordToolEvidence,
} from "../outcomes.js";
import { governProgress, type GovernorState } from "../evidence-governor.js";
import { isPackageInstallCommand } from "../task-evidence.js";
import { isProtocolPlaceholderOutput } from "../progress-pause-policy.js";

const DEPENDENCY_MUTATING_TOOL =
  /^(?:fs\.(?:write|writeMany|edit|replaceLines|append|delete)|pkg\.install)$/;

const DEPENDENCY_MUTATING_COMMAND = /\b(?:install|mkdir|create|generate|build)\b/i;

export interface OutcomeAccountingState {
  retryDependenciesChanged: boolean;
  retryEnvironmentChanged: boolean;
  governorState: GovernorState;
}

export interface OutcomeAccountingPorts {
  readonly outcomeState: OutcomeEnvelope;
  readonly maxSteps: number;
  readonly codingSession: boolean;
  readonly attemptCount: (call: ToolCall) => number;
  readonly moveTurn: (to: "exploring", reason: string) => void;
  readonly deferMessage: (message: ChatMessage) => void;
}

export interface OutcomeAccountingInput {
  readonly call: ToolCall;
  readonly result: ToolResult;
  readonly toolEventId: string;
  readonly artifactPath: string | undefined;
  readonly dispatchedTaskId: string | undefined;
  readonly probeStateKey: string | undefined;
}

const isShellLaunch = (name: string): boolean =>
  name === "shell.exec" || name === "shell.start";

const applyFailure = (
  ports: OutcomeAccountingPorts,
  state: OutcomeAccountingState,
  input: OutcomeAccountingInput,
): number => {
  const before = ports.outcomeState.failedHypotheses.length;
  recordFailedHypothesis(ports.outcomeState, {
    signature: `${input.call.name}:${input.result.exitCode ?? 1}`,
    premise: `${input.call.name} with ${JSON.stringify(input.call.args).slice(0, 1_000)}`,
  });
  state.retryDependenciesChanged = false;
  state.retryEnvironmentChanged = false;
  ports.moveTurn("exploring", `${input.call.name} failed; revise the premise`);
  return ports.outcomeState.failedHypotheses.length - before;
};

const applySuccess = (
  state: OutcomeAccountingState,
  input: OutcomeAccountingInput,
): void => {
  const command = String(input.call.args.command ?? "");
  const mutatesDependencies =
    DEPENDENCY_MUTATING_TOOL.test(input.call.name) ||
    (isShellLaunch(input.call.name) &&
      DEPENDENCY_MUTATING_COMMAND.test(command));
  state.retryDependenciesChanged ||= mutatesDependencies;
  state.retryEnvironmentChanged ||=
    input.call.name === "pkg.install" ||
    (isShellLaunch(input.call.name) && isPackageInstallCommand(command));
};

const governActivity = (
  ports: OutcomeAccountingPorts,
  state: OutcomeAccountingState,
  input: OutcomeAccountingInput,
  evidenceDelta: number,
  hypothesisDelta: number,
): void => {
  const governed = governProgress(state.governorState, "activity", {
    evidenceDelta,
    hypothesisDelta,
    repetitionScore: ports.attemptCount(input.call) > 1 ? 1 : 0,
    policy: {
      resourceEnvelope: Math.max(12, ports.maxSteps),
      emergencyCeiling: ports.codingSession
        ? Math.max(200, ports.maxSteps * 5)
        : Math.max(70, ports.maxSteps * 3),
      reflectionAfterNoDelta: ports.codingSession ? 5 : 3,
      pauseAfterNoDelta: ports.codingSession ? 24 : 6,
      repetitionThreshold: 0.8,
    },
  });
  state.governorState = governed.state;
  if (governed.recommendation !== "reflect") return;
  ports.deferMessage({
    role: "system",
    content:
      `PROGRESS GOVERNOR: ${governed.reason}. Reassess the current premise and choose the next action that can produce criterion-linked evidence.` +
      (ports.codingSession
        ? " Keep working — coding builds do not stop for a continue prompt."
        : ""),
  });
};

export const accountToolOutcome = (
  ports: OutcomeAccountingPorts,
  state: OutcomeAccountingState,
  input: OutcomeAccountingInput,
): void => {
  const newEvidence = recordToolEvidence(ports.outcomeState, {
    tool: input.call.name,
    callId: input.toolEventId,
    ok: input.result.ok,
    ...(input.result.exitCode !== undefined
      ? { exitCode: input.result.exitCode }
      : {}),
    output: input.result.output,
    ...(input.artifactPath ? { artifact: input.artifactPath } : {}),
    ...(input.dispatchedTaskId ? { taskId: input.dispatchedTaskId } : {}),
    ...(input.probeStateKey ? { stateKey: input.probeStateKey } : {}),
    args: input.call.args,
  });
  const hypothesisDelta = input.result.ok
    ? 0
    : applyFailure(ports, state, input);
  if (input.result.ok) applySuccess(state, input);
  if (isProtocolPlaceholderOutput(input.result.output)) return;
  governActivity(ports, state, input, newEvidence.length, hypothesisDelta);
};
