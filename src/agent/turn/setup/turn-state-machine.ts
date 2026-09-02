import type { ToolCall } from "../../../types.js";
import type { BackgroundJob } from "../../../tools/jobs.js";
import type { TurnState, TurnStateSnapshot } from "../../turn-state.js";
import { createTurnState, transitionTurn } from "../../turn-state.js";

export interface TurnStateMachine {
  readonly snapshot: () => TurnStateSnapshot;
  readonly move: (to: TurnState, reason?: string) => void;
}

export const createTurnStateMachine = (): TurnStateMachine => {
  let state = createTurnState();
  const move = (to: TurnState, reason?: string): void => {
    if (state.state === to) return;
    try {
      state = transitionTurn(state, to, reason);
      return;
    } catch {
    }
    if (to !== "succeeded" && to !== "partial") return;
    if (state.state === "understanding") {
      state = transitionTurn(
        state,
        "exploring",
        "response prepared for verification",
      );
    }
    if (state.state === "acting" || state.state === "exploring") {
      state = transitionTurn(state, "verifying", reason);
    }
    state = transitionTurn(state, to, reason);
  };
  return { snapshot: () => state, move };
};

const projectJob = (job: BackgroundJob | undefined) =>
  job
    ? [
        job.id,
        job.status,
        job.exitCode ?? null,
        job.signal ?? null,
        job.stdoutArtifact,
        job.artifacts.stdout.bytes,
        job.artifacts.stdout.sha256,
        job.stderrArtifact,
        job.artifacts.stderr.bytes,
        job.artifacts.stderr.sha256,
      ]
    : undefined;

export interface ProbeStatePorts {
  readonly getJob: (id: string) => BackgroundJob | undefined;
  readonly recentJobs: () => readonly BackgroundJob[];
}

export const createProbeStateKey =
  (ports: ProbeStatePorts) =>
  (call: ToolCall): string | undefined => {
    if (call.name === "shell.tail" && typeof call.args.id === "string") {
      const projected = projectJob(ports.getJob(call.args.id));
      return projected ? JSON.stringify(projected) : undefined;
    }
    if (call.name === "shell.jobs") {
      return JSON.stringify(
        ports
          .recentJobs()
          .map((job) => projectJob(job))
          .filter(Boolean),
      );
    }
    return undefined;
  };
