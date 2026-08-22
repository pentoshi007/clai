import { safeCwd } from "../../os/cwd.js";
import {
  renderExitSummary,
  type ExitSummaryInput,
} from "../rendering/exit-summary.js";
import type { AppServices } from "./composition-root.js";

export interface ExitEpilogueOptions {
  readonly services: AppServices;
  readonly startedAt: number;
  /** Renderer-owned sink; ui-core never writes terminal bytes itself. */
  readonly write: (text: string) => void;
  readonly enabled?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly cwd?: (() => string) | undefined;
}

export interface ExitEpilogue {
  readonly capture: () => void;
  readonly run: () => void;
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
    width: capabilities.columns,
    color: !capabilities.noColor,
    unicode: capabilities.unicode,
  };
}

/**
 * `capture` must run while the session is still live (register it as the FIRST
 * disposer so reverse-order teardown runs it last, after the final history
 * flush); `run` renders the captured snapshot once the terminal is back.
 */
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
      options.write(renderExitSummary(snapshot));
    },
  };
}
