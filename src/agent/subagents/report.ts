import { SUBAGENT_LIMITS } from "../../store/subagents.js";

export function subagentReportStatus(text: string): "completed" | "partial" | undefined {
  const status = /^Status: (complete|partial)\r?\n/i.exec(text.trimStart())?.[1]?.toLowerCase();
  if (!status || text.trim().length < 160 || text.length > SUBAGENT_LIMITS.report) return undefined;
  const sections = new Map(text.split(/^## /m).slice(1).map((section) => {
    const line = section.indexOf("\n");
    return line < 0 ? [section.trim().toLowerCase(), ""] : [section.slice(0, line).trim().toLowerCase(), section.slice(line + 1).trim()];
  }));
  if (!["findings", "evidence", "next steps", "coverage gaps"].every((heading) => sections.get(heading))) return undefined;
  if (!/(?:https?:\/\/\S+|[\w./-]+(?:(?::|#L?)|`?\s+lines?\s+)[1-9]\d*\b)/i.test(sections.get("evidence")!)) return undefined;
  return status === "complete" ? "completed" : "partial";
}
