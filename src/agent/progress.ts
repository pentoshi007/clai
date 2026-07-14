import type { TaskPlan } from "./task-plan.js";
import type { ToolCall, ToolResult } from "../types.js";

export interface ProgressEvaluation {
  madeProgress: boolean;
  goalSatisfied: boolean;
  shouldContinue: boolean;
  reason: string;
}

/**
 * Deterministic heuristics to evaluate whether a tool call made
 * progress toward the plan goal. Used to decide whether to continue
 * the agent loop or nudge the model to summarize.
 */
export function evaluateProgress(
  plan: TaskPlan | undefined,
  call: ToolCall,
  result: ToolResult,
): ProgressEvaluation {
  const output = result.output.toLowerCase();
  const ok = result.ok;

  // Command not found → no progress, suggest install
  if (
    !ok &&
    (output.includes("command not found") ||
      output.includes("not recognized") ||
      output.includes("no such file or directory"))
  ) {
    return {
      madeProgress: false,
      goalSatisfied: false,
      shouldContinue: true,
      reason: "Command/file not found — consider checking tool availability or installing the missing tool.",
    };
  }

  // Permission denied
  if (!ok && output.includes("permission denied")) {
    return {
      madeProgress: false,
      goalSatisfied: false,
      shouldContinue: true,
      reason: "Permission denied — may need elevated privileges or different approach.",
    };
  }

  // Network discovery goals
  if (plan?.steps.some((s) => s.kind === "network-discovery")) {
    if (output.includes("hosts up") || output.includes("active device")) {
      return {
        madeProgress: true,
        goalSatisfied: true,
        shouldContinue: false,
        reason: "Network discovery complete — devices found.",
      };
    }
  }

  // DNS goals
  if (call.name === "dns.lookup") {
    if (ok && output.length > 10) {
      return {
        madeProgress: true,
        goalSatisfied: true,
        shouldContinue: false,
        reason: "DNS records retrieved.",
      };
    }
    if (output.includes("nxdomain")) {
      return {
        madeProgress: true,
        goalSatisfied: true,
        shouldContinue: false,
        reason: "Domain does not exist (NXDOMAIN).",
      };
    }
  }

  // Whois goals
  if (call.name === "whois.lookup" && ok && output.length > 50) {
    return {
      madeProgress: true,
      goalSatisfied: true,
      shouldContinue: false,
      reason: "Whois data retrieved.",
    };
  }

  // File edit/write goals
  if (
    (call.name === "fs.edit" ||
      call.name === "fs.replaceLines" ||
      call.name === "fs.write" ||
      call.name === "fs.append") &&
    ok
  ) {
    return {
      madeProgress: true,
      goalSatisfied: true,
      shouldContinue: false,
      reason: "File modification successful.",
    };
  }

  // File delete goals
  if (call.name === "fs.delete" && ok) {
    return {
      madeProgress: true,
      goalSatisfied: true,
      shouldContinue: false,
      reason: "File deletion successful.",
    };
  }

  // Generic: if the call succeeded and produced output, we made progress
  if (ok && output.length > 0) {
    return {
      madeProgress: true,
      goalSatisfied: false,
      shouldContinue: true,
      reason: "Tool returned output — progress likely.",
    };
  }

  // Generic: call failed
  if (!ok) {
    return {
      madeProgress: false,
      goalSatisfied: false,
      shouldContinue: true,
      reason: `Tool ${call.name} failed (exit=${result.exitCode ?? "?"}).`,
    };
  }

  return {
    madeProgress: true,
    goalSatisfied: false,
    shouldContinue: true,
    reason: "Continuing.",
  };
}
