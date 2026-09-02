import { safeCwd } from "../../os/cwd.js";
import {
  renderExitSummary,
  type ExitSummaryInput,
} from "../rendering/exit-summary.js";
import type { AppServices } from "./composition-root.js";

export interface ExitEpilogueOptions {
  readonly services: AppServices;
  readonly startedAt: number;
  readonly write: (text: string) => void | Promise<void>;
  readonly enabled?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly cwd?: (() => string) | undefined;
  readonly columns?: (() => number | undefined) | undefined;
}

export interface ExitEpilogue {
  readonly capture: () => void;
  readonly run: () => void | Promise<void>;
}

function liveColumns(options: ExitEpilogueOptions): number | undefined {
  const columns = options.columns?.();
  return typeof columns === "number" && columns > 0 ? columns : undefined;
}

export function buildExitSummaryInput(
  options: ExitEpilogueOptions,
): ExitSummaryInput {
  const { services } = options;
  const state = services.session.getState();
  const now = options.now ?? Date.now;
  const { capabilities } = services;
  return {
    usage: services.session.usageReport(),
    sessionId: state.sessionId,
    ...(state.title ? { title: state.title } : {}),
    messages: services.session.messages.length,
    cwd: (options.cwd ?? safeCwd)(),
    durationMs: Math.max(0, now() - options.startedAt),
    resumable: services.session.canResumeFromHistory(),
    width: liveColumns(options) ?? capabilities.columns,
    color: !capabilities.noColor,
    unicode: capabilities.unicode,
  };
}

export function createExitEpilogue(options: ExitEpilogueOptions): ExitEpilogue {
  const enabled = options.enabled ?? true;
  let snapshot: ExitSummaryInput | undefined;
  return {
    capture() {
      if (!enabled || snapshot) return;
      snapshot = buildExitSummaryInput(options);
    },
    run() {
      if (!enabled) return;
      snapshot ??= buildExitSummaryInput(options);
      return options.write(renderExitSummary(snapshot));
    },
  };
}
