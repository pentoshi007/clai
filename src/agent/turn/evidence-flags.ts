import type { RecoveryBudgets } from "../must-continue.js";
import type { ToolEvidenceSignals } from "./tool-evidence-signals.js";

export interface TurnEvidenceFlags {
  sawSuccessfulMutation: boolean;
  sawServerStart: boolean;
  sawServerTail: boolean;
  sawActivePentestTest: boolean;
  sawLocalHttpProbe: boolean;
  sawFailedLocalHttpProbe: boolean;
  sawScaffoldOk: boolean;
  sawFeatureImplWrite: boolean;
  sawLocalAppMaterialWork: boolean;
  sawPlanCreateOk: boolean;
  instructionsChangedThisRound: boolean;
}

export const createTurnEvidenceFlags = (): TurnEvidenceFlags => ({
  sawSuccessfulMutation: false,
  sawServerStart: false,
  sawServerTail: false,
  sawActivePentestTest: false,
  sawLocalHttpProbe: false,
  sawFailedLocalHttpProbe: false,
  sawScaffoldOk: false,
  sawFeatureImplWrite: false,
  sawLocalAppMaterialWork: false,
  sawPlanCreateOk: false,
  instructionsChangedThisRound: false,
});

const applyLocalProbe = (
  flags: TurnEvidenceFlags,
  recovery: RecoveryBudgets,
  probe: ToolEvidenceSignals["localProbe"],
): void => {
  if (probe === "failure") {
    flags.sawFailedLocalHttpProbe = true;
    flags.sawLocalHttpProbe = false;
    return;
  }
  if (probe === "none") return;
  flags.sawLocalHttpProbe = true;
  flags.sawFailedLocalHttpProbe = false;
  if (probe === "success") recovery.failedProbe = 0;
};

export const applyToolEvidenceSignals = (
  flags: TurnEvidenceFlags,
  recovery: RecoveryBudgets,
  evidence: ToolEvidenceSignals,
): void => {
  if (evidence.mutationLanded) flags.sawSuccessfulMutation = true;
  if (evidence.freshProbeFailure) flags.sawSuccessfulMutation = false;
  if (evidence.evidenceWorkTool) {
    recovery.actionIntent = 0;
    recovery.errorFix = 0;
  }
  if (evidence.serverStarted) flags.sawServerStart = true;
  if (evidence.serverTailed) flags.sawServerTail = true;
  if (evidence.activePentestTest) flags.sawActivePentestTest = true;
  applyLocalProbe(flags, recovery, evidence.localProbe);
  if (evidence.scaffoldCreated) flags.sawScaffoldOk = true;
  if (evidence.featureWrite) flags.sawFeatureImplWrite = true;
  if (evidence.localAppMaterialWork) flags.sawLocalAppMaterialWork = true;
};
