import type { CloseOwnerResult } from "../ports/interactive-sessions-port.js";
import type { ToolResult } from "../../types.js";

export function mergeCancelAllResult(
  jobs: ToolResult | undefined,
  interactive: CloseOwnerResult | undefined,
): ToolResult {
  const notes: string[] = [];
  if (interactive && interactive.closed > 0) {
    notes.push(`Closed ${interactive.closed} interactive session(s).`);
  }
  for (const failure of interactive?.failures ?? []) {
    notes.push(`[${failure.code}] ${failure.message}`);
  }
  const interactiveOk = (interactive?.failures.length ?? 0) === 0;
  if (!jobs) {
    return {
      ok: interactiveOk,
      output: [
        "Turn cancelled; no background-job service is configured.",
        ...notes,
      ].join("\n"),
    };
  }
  if (notes.length === 0) return jobs;
  return {
    ...jobs,
    ok: jobs.ok && interactiveOk,
    output: [jobs.output, ...notes].join("\n"),
  };
}
