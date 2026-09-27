/**
 * Agent quality / reliability harness scaffolding (audit S5).
 *
 * These helpers measure request composition and scenario labels without
 * changing production agent behavior. Use with mocked providers or offline
 * fixtures; do not treat lower token counts as success by themselves.
 */

import type { ChatMessage, ToolDefinition } from "../../src/types.js";
import {
  buildContextBreakdown,
  type ContextBreakdown,
} from "../../src/agent/context-breakdown.js";
import { estimateMessagesTokens } from "../../src/agent/context-manager.js";
import { composeAgentSystemPrompt } from "../../src/agent/prompt-composer.js";
import { renderAgentSystemPrompt } from "../../src/prompts/index.js";
import { getReliabilityPolicy } from "../../src/agent/reliability-policy.js";
import { autoCompactTriggerTokens } from "../../src/agent/request-budget.js";

/** Scenario classes from the reliability audit. */
export type QualityScenarioId =
  | "small_coding"
  | "multi_file_feature"
  | "long_debug"
  | "repo_refactor"
  | "ordered_instructions"
  | "conflicting_requirements"
  | "long_session_recall"
  | "tool_failure_recovery"
  | "provider_disconnect"
  | "large_context"
  | "focused_context"
  | "pentest_scoped";

export interface QualityScenario {
  readonly id: QualityScenarioId;
  readonly description: string;
  /** What "success" means for this fixture (human checklist). */
  readonly successCriteria: readonly string[];
  /** Non-negotiable behaviors that must not regress. */
  readonly nonNegotiables: readonly string[];
}

export const QUALITY_SCENARIOS: readonly QualityScenario[] = [
  {
    id: "small_coding",
    description: "Single-file focused fix",
    successCriteria: ["Correct patch", "Re-verify with test or command"],
    nonNegotiables: ["Instruction following", "No fabricated tool results"],
  },
  {
    id: "multi_file_feature",
    description: "Multi-file feature with checks",
    successCriteria: ["Feature works", "Automated checks run"],
    nonNegotiables: ["Plan/task evidence when multi-step", "No silent skips"],
  },
  {
    id: "long_debug",
    description: "Fail → fix → retest loop",
    successCriteria: ["Root cause fixed", "Failing check re-run green"],
    nonNegotiables: ["Must not stop at diagnosis-only"],
  },
  {
    id: "repo_refactor",
    description: "Cross-file rename/refactor",
    successCriteria: ["All call sites updated", "Build/tests pass"],
    nonNegotiables: ["Dependency/call-chain awareness"],
  },
  {
    id: "ordered_instructions",
    description: "User lists steps that must run in order",
    successCriteria: ["Order preserved", "All steps evidenced"],
    nonNegotiables: ["Action order fidelity"],
  },
  {
    id: "conflicting_requirements",
    description: "Mid-session requirement change",
    successCriteria: ["Latest constraint wins", "Prior work not blindly repeated"],
    nonNegotiables: ["Context retention of new constraint"],
  },
  {
    id: "long_session_recall",
    description: "Recall early decisions after many steps",
    successCriteria: ["Early constraint still honored after compact/growth"],
    nonNegotiables: ["No amnesia of user constraints"],
  },
  {
    id: "tool_failure_recovery",
    description: "Tool error then alternate approach",
    successCriteria: ["Does not loop same failure", "Completes via alternate"],
    nonNegotiables: ["LoopGuard / recovery paths"],
  },
  {
    id: "provider_disconnect",
    description: "Simulated disconnect/retry",
    successCriteria: ["Safe resume without duplicate destructive work"],
    nonNegotiables: ["Recoverability", "Idempotent awareness"],
  },
  {
    id: "large_context",
    description: "Genuinely large multi-artifact task",
    successCriteria: ["Uses needed context correctly"],
    nonNegotiables: ["Must not truncate critical evidence blindly"],
  },
  {
    id: "focused_context",
    description: "Task that only needs a small slice of repo",
    successCriteria: ["Completes without whole-repo dump"],
    nonNegotiables: ["Correctness over token thrift"],
  },
  {
    id: "pentest_scoped",
    description: "Authorized pentest with scope + evidence",
    successCriteria: [
      "Stays in scope",
      "Findings have command+output evidence",
      "No local-dev-server drift on remote eng.",
    ],
    nonNegotiables: [
      "Scope compliance",
      "Evidence preservation",
      "Sequential validation",
    ],
  },
];

export interface CompositionSnapshot {
  readonly scenarioId?: QualityScenarioId | undefined;
  readonly breakdown: ContextBreakdown;
  readonly estimatedHistoryTokens: number;
}

/** Snapshot message composition for a harness run (offline). */
export function snapshotComposition(
  messages: readonly ChatMessage[],
  tools?: readonly ToolDefinition[],
  scenarioId?: QualityScenarioId,
): CompositionSnapshot {
  return {
    scenarioId,
    breakdown: buildContextBreakdown(messages, tools),
    estimatedHistoryTokens: estimateMessagesTokens([...messages]),
  };
}

/**
 * Baseline cold-start system composition (no history).
 * Useful to detect accidental constitution bloat regressions.
 */
export function baselineColdSystemTokens(toolList: string): {
  readonly systemChars: number;
  readonly systemEstTokens: number;
  readonly composedEstTokens: number;
} {
  const constitution = renderAgentSystemPrompt(toolList, { nativeTools: true });
  const composed = composeAgentSystemPrompt({
    mode: "agent",
    nativeToolsActive: true,
    sections: [
      { kind: "constitution", content: constitution, mandatory: true },
      {
        kind: "outcome",
        content: "OUTCOME CONTRACT\nGoal: harness baseline",
        mandatory: true,
      },
      {
        kind: "plan",
        content: "ACTIVE PLAN\nNo persisted plan is active for this turn.",
        mandatory: true,
      },
      {
        kind: "scope",
        content:
          "ENGAGEMENT SCOPE\nNo active remote-security scope applies to this turn.",
        mandatory: true,
      },
      {
        kind: "context",
        content: "TASK STATE\nMode: agent. Current request: baseline",
        mandatory: true,
      },
    ],
  });
  return {
    systemChars: constitution.length,
    systemEstTokens: Math.ceil(constitution.length / 4),
    composedEstTokens: composed.estimatedTokens,
  };
}

export interface QualityRunRecord {
  readonly scenarioId: QualityScenarioId;
  readonly passed: boolean;
  readonly notes: string;
  readonly composition?: CompositionSnapshot | undefined;
  readonly latencyMs?: number | undefined;
  readonly retries?: number | undefined;
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  /** Soft early compact / adaptive maxTokens / etc. — optional experiment tags. */
  readonly experimentTags?: readonly string[] | undefined;
}

/** Tags describing which reliability experiments are active (E1–E6). */
export function activeExperimentTags(): string[] {
  const p = getReliabilityPolicy();
  const tags: string[] = [];
  tags.push(`E1:auto-compact@${autoCompactTriggerTokens()}`);
  tags.push(`E2:fs-cap=${p.fsPassthroughCapChars}`);
  if (p.adaptiveMaxTokens) tags.push("E3:adaptive-maxTokens");
  if (p.freeTierContextGuard) tags.push("E4:free-tier-guard");
  if (p.toolResultDedup) tags.push("E5:tool-dedup");
  if (p.slimNativePrompt) tags.push("E6:slim-native");
  return tags;
}

/** Compare two runs: quality gates first; tokens only as secondary metrics. */
export function compareQualityRuns(
  baseline: QualityRunRecord,
  candidate: QualityRunRecord,
): {
  readonly qualityRegressed: boolean;
  readonly reason: string;
} {
  if (baseline.scenarioId !== candidate.scenarioId) {
    return {
      qualityRegressed: true,
      reason: "scenario mismatch",
    };
  }
  if (baseline.passed && !candidate.passed) {
    return {
      qualityRegressed: true,
      reason: "candidate failed a scenario baseline passed",
    };
  }
  return { qualityRegressed: false, reason: "ok" };
}
