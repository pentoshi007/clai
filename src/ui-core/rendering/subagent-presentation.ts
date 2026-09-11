import type { Theme } from "./theme.js";

export interface SubagentSpan {
  readonly text: string;
  readonly fg: keyof Theme;
  readonly bold?: boolean;
}

function statusColor(status: string): keyof Theme {
  if (/^(?:✓|completed|complete|succeeded)$/i.test(status)) return "success";
  if (/^(?:✗|failed|error)$/i.test(status)) return "diffDel";
  return "activity";
}

export function subagentLineSpans(line: string): readonly SubagentSpan[] | undefined {
  const tool = /^(\s*)([→✓✗])(\s+)([\w-]+\.[\w.-]+)(.*)$/.exec(line);
  if (tool) {
    return [
      { text: `${tool[1]}${tool[2]}${tool[3]}`, fg: statusColor(tool[2]!) },
      { text: tool[4]!, fg: "cyan", bold: true },
      { text: tool[5]!, fg: "muted" },
    ];
  }
  const status = /^(\s*)(running|stopping|stopped|completed|partial|failed|error)(\s+·.*)$/.exec(line);
  if (status) {
    return [
      { text: `${status[1]}${status[2]}`, fg: statusColor(status[2]!), bold: true },
      { text: status[3]!, fg: "muted" },
    ];
  }
  const reportStatus = /^(\s*Status:\s*)(complete|completed|partial|failed|error|stopped)(\b.*)$/i.exec(line);
  if (reportStatus) {
    return [
      { text: reportStatus[1]!, fg: "cyan" },
      { text: reportStatus[2]!, fg: statusColor(reportStatus[2]!), bold: true },
      { text: reportStatus[3]!, fg: "muted" },
    ];
  }
  const metadata = /^(\s*(?:Workspace|Agent|Recovery):)(.*)$/.exec(line);
  if (metadata) {
    return [
      { text: metadata[1]!, fg: "cyan" },
      { text: metadata[2]!, fg: "muted" },
    ];
  }
  if (/^\s*(?:#{1,6}\s+)?(?:Error|Stopped|Partial report)\b/.test(line)) {
    return [{ text: line, fg: /\bError\b/.test(line) ? "diffDel" : "activity", bold: true }];
  }
  if (/^\s*#{1,6}\s+/.test(line) || /^\s*(?:Assignment|Context|Activity|Report|Findings|Evidence|Next steps|Coverage gaps)\s*$/.test(line)) {
    return [{ text: line, fg: "magenta", bold: true }];
  }
  if (/^\s*✗\s/.test(line)) return [{ text: line, fg: "diffDel" }];
  if (/^\s*✓\s/.test(line)) return [{ text: line, fg: "success" }];
  if (/^\s*(?:→\s|Notice:|In progress\b|Waiting for the first update)/.test(line)) {
    return [{ text: line, fg: "activity" }];
  }
  if (/^\s*(?:No result recorded|No activity recorded)/.test(line)) return [{ text: line, fg: "muted" }];
  return undefined;
}
