import type { ChatMessage } from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";
import type { TaskEvidence } from "../../store/plan.js";
import { patchPlanMeta } from "../../store/plan.js";
import { detectPackageManager } from "../workspace-orient.js";
import {
  buildSessionStateBlock,
  upsertSessionStateMessage,
} from "../session-state.js";
import { upsertRequestContextMessage } from "../../llm/system-messages.js";
import {
  planContextMessage,
  removePlanContextMessage,
  upsertPlanContextMessage,
} from "../plan-tool.js";
import { buildTurnSessionStateSnapshot } from "./session-state-projection.js";

export type PlanMutator = (
  mutator: (draft: SessionPlan) => boolean | void,
) => Promise<unknown>;

export const persistProjectRootOnPlan = async (
  mutatePlan: PlanMutator,
  root: string,
): Promise<void> => {
  const packageManager = detectPackageManager(root);
  await mutatePlan((draft) => {
    patchPlanMeta(draft, {
      projectRoot: root,
      ...(packageManager ? { packageManager } : {}),
    });
  }).catch(() => undefined);
};

export const persistTaskEvidence = async (
  mutatePlan: PlanMutator,
  taskId: string,
  evidence: TaskEvidence,
): Promise<void> => {
  await mutatePlan((draft) => {
    const task = draft.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return false;
    task.evidence = evidence;
  }).catch(() => undefined);
};

export interface SessionStateRefreshPorts {
  readonly messages: ChatMessage[];
  readonly prompt: string;
  readonly requestContextMessage: string;
  readonly refreshInjectedBlocks: () => void;
  readonly suppressed: () => boolean;
  readonly activePlan: () => SessionPlan | undefined;
  readonly planApproved: () => boolean;
  readonly runningJobs: () => readonly unknown[];
  readonly projectRoot: () => string | undefined;
  readonly requiresState: () => boolean;
  readonly snapshotFlags: () => {
    featureAppRequired: boolean;
    featureSeen: boolean;
    scaffoldOk: boolean;
    serverStarted: boolean;
    serverProbedOk: boolean;
    lastProbeFailed: boolean;
    pentestSession: boolean;
  };
}

export const createSessionStateRefresher =
  (ports: SessionStateRefreshPorts) =>
  (plan?: SessionPlan | null | undefined): void => {
    ports.refreshInjectedBlocks();
    if (ports.suppressed()) return;
    const runningJobs = ports.runningJobs();
    const live = plan === null ? undefined : (plan ?? ports.activePlan());
    if (!ports.requiresState() && !live && runningJobs.length === 0) {
      if (plan === null) removePlanContextMessage(ports.messages);
      return;
    }
    const root = ports.projectRoot() ?? live?.meta?.projectRoot;
    const packageManager =
      live?.meta?.packageManager ??
      (root ? detectPackageManager(root) : undefined);
    const flags = ports.snapshotFlags();
    const snapshot = buildTurnSessionStateSnapshot({
      plan: live,
      prompt: ports.prompt,
      projectRoot: root,
      packageManager,
      runningJobs: runningJobs as never,
      ...flags,
    });
    upsertRequestContextMessage(ports.messages, ports.requestContextMessage);
    if (live) {
      upsertPlanContextMessage(
        ports.messages,
        planContextMessage(live, ports.planApproved()),
      );
    } else {
      removePlanContextMessage(ports.messages);
    }
    upsertSessionStateMessage(
      ports.messages,
      buildSessionStateBlock(snapshot),
    );
  };
