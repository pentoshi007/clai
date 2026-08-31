import type { TaskAnalysis } from "./task-analyzer.js";

export interface StepBudgetInput {
  analysis: TaskAnalysis;
  maxSteps: number;
  buildLike: boolean;
  pentestLike: boolean;
  hasHistory: boolean;
}

export function computeStepBudget(input: StepBudgetInput): number {
  const { analysis, maxSteps, buildLike, pentestLike, hasHistory } = input;
  let budget =
    analysis.complexity === "simple"
      ? 20
      : analysis.complexity === "standard"
        ? 40
        : maxSteps;

  if (buildLike || pentestLike || analysis.shouldPlan) {
    budget = Math.max(budget, maxSteps);
  } else if (hasHistory) {
    budget = Math.max(budget, 40);
  }

  if (analysis.complexity === "complex") {
    budget = Math.max(budget, Math.min(maxSteps, 80));
  }

  return budget;
}

export function computeMaxIterations(stepBudget: number): number {
  return stepBudget * 3;
}
