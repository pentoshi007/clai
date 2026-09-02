import type { SessionPlan } from "../../../store/plan.js";
import type { TurnEvidenceFlags } from "../evidence-flags.js";

export const rehydrateEvidenceFlagsFromPlan = (
  flags: TurnEvidenceFlags,
  plan: SessionPlan | undefined,
): void => {
  if (!plan) return;
  for (const task of plan.tasks) {
    const evidence = task.evidence;
    if (!evidence) continue;
    if (
      evidence.sawDevServerStart ||
      evidence.sawServerReady ||
      evidence.sawPortListening
    ) {
      flags.sawServerStart = true;
    }
    if (evidence.sawServerReady || evidence.sawDevServerStart) {
      flags.sawServerTail = true;
    }
    if (evidence.sawLocalHttpProbeOk) flags.sawLocalHttpProbe = true;
    if (evidence.sawRemoteActiveTestOk) flags.sawActivePentestTest = true;
  }
};
