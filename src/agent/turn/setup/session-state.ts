import type { ChatMessage } from "../../../types.js";
import type { SessionPlan } from "../../../store/plan.js";
import type { BackgroundJob } from "../../../tools/jobs.js";
import type { TurnEvidenceFlags } from "../evidence-flags.js";
import { createSessionStateRefresher } from "../plan-persistence.js";

export interface SessionStateSetupInput {
  readonly messages: ChatMessage[];
  readonly prompt: string;
  readonly requestContextMessage: string;
  readonly refreshInjectedBlocks: () => void;
  readonly suppressed: boolean;
  readonly requiresState: boolean;
  readonly featureAppAsk: boolean;
  readonly pentestSession: boolean;
  readonly evidenceFlags: TurnEvidenceFlags;
  readonly activePlan: () => SessionPlan | undefined;
  readonly planApproved: () => boolean;
  readonly runningJobs: () => readonly BackgroundJob[];
  readonly projectRoot: () => string | undefined;
}

export const buildSessionStateRefresher = (
  input: SessionStateSetupInput,
): ((plan?: SessionPlan | null | undefined) => void) =>
  createSessionStateRefresher({
    messages: input.messages,
    prompt: input.prompt,
    requestContextMessage: input.requestContextMessage,
    refreshInjectedBlocks: input.refreshInjectedBlocks,
    suppressed: () => input.suppressed,
    activePlan: input.activePlan,
    planApproved: input.planApproved,
    runningJobs: input.runningJobs,
    projectRoot: input.projectRoot,
    requiresState: () => input.requiresState,
    snapshotFlags: () => ({
      featureAppRequired: input.featureAppAsk,
      featureSeen: input.evidenceFlags.sawFeatureImplWrite,
      scaffoldOk: input.evidenceFlags.sawScaffoldOk,
      serverStarted: input.evidenceFlags.sawServerStart,
      serverProbedOk: input.evidenceFlags.sawLocalHttpProbe,
      lastProbeFailed: input.evidenceFlags.sawFailedLocalHttpProbe,
      pentestSession: input.pentestSession,
    }),
  });
