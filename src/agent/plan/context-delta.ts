import type { ChatMessage } from "../../types.js";
import type { PlanTask, SessionPlan, TaskState } from "../../store/plan.js";
import { planContextMessage, planNextDirective } from "./context-message.js";
import { PLAN_CONTEXT_PREFIX, upsertPlanContextMessage } from "../plan-tool.js";

export const PLAN_UPDATE_PREFIX = `${PLAN_CONTEXT_PREFIX} UPDATE`;
export const PLAN_UPDATE_RESNAPSHOT_LINES = 12;

interface EmittedPlanContext {
  readonly message: ChatMessage;
  readonly structure: string;
  readonly states: ReadonlyMap<string, TaskState>;
  readonly deltaLines: number;
}

export interface PlanContextTracker {
  readonly emit: (messages: ChatMessage[], plan: SessionPlan, approved: boolean) => void;
}

const taskStructure = (task: PlanTask): unknown[] => [
  task.id,
  task.title,
  task.parentTaskId,
  task.jobId,
  task.processId,
  task.aliases,
  task.dependencies,
  task.resourceLocks,
  task.acceptanceCriteria,
];

const planStructureKey = (plan: SessionPlan, approved: boolean): string =>
  JSON.stringify([
    plan.goal,
    plan.status,
    plan.detail,
    approved,
    plan.meta?.projectRoot,
    plan.meta?.packageManager,
    plan.tasks.map(taskStructure),
  ]);

const taskStates = (plan: SessionPlan): Map<string, TaskState> =>
  new Map(plan.tasks.map((task) => [task.id, task.state]));

const stateChanges = (
  previous: ReadonlyMap<string, TaskState>,
  plan: SessionPlan,
): string[] =>
  plan.tasks.flatMap((task) => {
    const before = previous.get(task.id);
    return before === task.state ? [] : [`${task.id}: ${before} → ${task.state}`];
  });

const latestPlanBlock = (messages: readonly ChatMessage[]): ChatMessage | undefined => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "system" && message.content.startsWith(PLAN_CONTEXT_PREFIX)) {
      return message;
    }
  }
  return undefined;
};

const renderPlanUpdate = (
  changes: readonly string[],
  plan: SessionPlan,
  approved: boolean,
): string => {
  const next = approved ? planNextDirective(plan) : undefined;
  return [
    `${PLAN_UPDATE_PREFIX} (task states changed since the ACTIVE PLAN above; all other plan details are unchanged):`,
    ...changes,
    ...(next ? [`Next: ${next}`] : []),
  ].join("\n");
};

export const createPlanContextTracker = (): PlanContextTracker => {
  let emitted: EmittedPlanContext | undefined;

  const snapshot = (messages: ChatMessage[], plan: SessionPlan, approved: boolean, structure: string): void => {
    upsertPlanContextMessage(messages, planContextMessage(plan, approved));
    const message = latestPlanBlock(messages);
    emitted = message ? { message, structure, states: taskStates(plan), deltaLines: 0 } : undefined;
  };

  return {
    emit: (messages, plan, approved) => {
      const structure = planStructureKey(plan, approved);
      const comparable = emitted &&
        emitted.structure === structure &&
        latestPlanBlock(messages) === emitted.message;
      if (!emitted || !comparable) {
        snapshot(messages, plan, approved, structure);
        return;
      }
      const changes = stateChanges(emitted.states, plan);
      if (changes.length === 0) return;
      const deltaLines = emitted.deltaLines + changes.length;
      if (deltaLines > PLAN_UPDATE_RESNAPSHOT_LINES) {
        snapshot(messages, plan, approved, structure);
        return;
      }
      const message: ChatMessage = { role: "system", content: renderPlanUpdate(changes, plan, approved) };
      messages.push(message);
      emitted = { message, structure, states: taskStates(plan), deltaLines };
    },
  };
};
