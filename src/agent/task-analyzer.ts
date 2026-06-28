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
 * Pentest / security keywords — these tasks are inherently multi-step and
 * always deserve the full step budget regardless of how terse the prompt is.
 */
const PENTEST_RE =
  /\b(?:pentest|pen[\s-]?test|penetration|security\s*(?:test|audit|scan|assess)|csrf|xss|sqli|sql[\s-]?inject|rce|lfi|rfi|ssrf|idor|xxe|deserialization|brute[\s-]?force|enumerat|exploit|vulnerabilit|recon|bug[\s-]?bounty|ctf|capture[\s-]?the[\s-]?flag|red[\s-]?team|offensive|nmap|nikto|nuclei|ffuf|gobuster|sqlmap|hydra|metasploit)\b/i;

/**
 * Complexity estimator. Uses keyword detection for pentest/security tasks
 * (always complex) and falls back to word-count heuristic otherwise.
 * No pre-baked steps — the AI decides everything dynamically.
 */
export function analyzeTask(prompt: string): TaskAnalysis {
  const words = prompt.trim().split(/\s+/).length;
  // Pentest tasks are inherently multi-step — always complex.
  const complexity: TaskComplexity = PENTEST_RE.test(prompt)
    ? "complex"
    : words <= 5
      ? "simple"
      : words <= 30
        ? "standard"
        : "complex";
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
