import type { EngagementScope } from "../store/scope.js";
import { isScopeActive } from "../store/scope.js";

export function scopeContextMessage(
  scope: EngagementScope | undefined,
): string | undefined {
  if (!scope || !isScopeActive(scope)) return undefined;
  const lines = ["ENGAGEMENT SCOPE (hard boundary for this session):"];
  if (scope.name?.trim()) lines.push(`name: ${scope.name.trim()}`);
  if (scope.authorizedTargets.length) {
    lines.push(`authorized: ${scope.authorizedTargets.join(", ")}`);
  }
  if (scope.excludedTargets?.length) {
    lines.push(`excluded: ${scope.excludedTargets.join(", ")}`);
  }
  if (scope.allowedPhases?.length) {
    lines.push(`phases: ${scope.allowedPhases.join(", ")}`);
  }
  if (scope.authorizationNote?.trim()) {
    lines.push(`note: ${scope.authorizationNote.trim()}`);
  }
  lines.push(
    "Do not scan or attack hosts outside authorized targets. If a tool is refused as OUT_OF_SCOPE, do not stop: explain the boundary briefly and continue with useful in-scope work without retrying the same call.",
  );
  return lines.join("\n");
}

export function outOfScopeToolMessage(input: {
  target: string;
  reason: string;
  allowed?: readonly string[] | undefined;
}): string {
  const allowed = input.allowed?.length
    ? ` Authorized targets: ${input.allowed.join(", ")}.`
    : "";
  return `OUT_OF_SCOPE: tool call was not run for ${input.target}: ${input.reason}.${allowed} Continue the task using only in-scope targets; do not retry this unchanged call and do not end the agent solely because it was refused.`;
}
