import type {
  TaskComplexity,
  TaskKind,
  PlanStep,
} from "./task-plan.js";

export interface TaskAnalysis {
  complexity: TaskComplexity;
  shouldPlan: boolean;
  category: TaskKind;
  goal: string;
  needsNetworkContext: boolean;
  needsToolPreflight: boolean;
  likelyTools: string[];
  stopWhen: string;
  suggestedSteps: PlanStep[];
}

/**
 * Minimal complexity estimator. Returns ONLY a complexity level based on
 * prompt length. No hardcoded patterns, no pre-baked steps — the AI
 * decides everything dynamically.
 */
export function analyzeTask(prompt: string): TaskAnalysis {
  const words = prompt.trim().split(/\s+/).length;
  const complexity: TaskComplexity =
    words <= 5 ? "simple" : words <= 30 ? "standard" : "complex";
  return {
    complexity,
    shouldPlan: false,
    category: "other",
    goal: prompt.slice(0, 100),
    needsNetworkContext: false,
    needsToolPreflight: false,
    likelyTools: [],
    stopWhen: "",
    suggestedSteps: [],
  };
}
