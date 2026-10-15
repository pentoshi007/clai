const LABELS: Readonly<Record<string, string>> = {
  "shell.exec": "Shell",
  "shell.jobs": "Jobs",
  "shell.tail": "Job output",
  "shell.wait": "Waited",
  "shell.stop": "Stopped job",
  "fs.read": "Explored",
  "fs.edit": "Edited",
  "fs.write": "Wrote",
  "fs.append": "Appended",
  "fs.replaceLines": "Edited",
  "fs.delete": "Deleted",
  "fs.writeMany": "Wrote files",
  "tool.batch": "Tools",
  "web.search": "Searched the web",
  "web.fetch": "Opened",
  "http.fetch": "Fetched",
  "image.view": "Viewed image",
  "image.ocr": "Read image",
  "pdf.read": "Read PDF",
  "terminal.start": "Terminal",
  "terminal.send": "Sent to terminal",
  "terminal.read": "Terminal output",
  "terminal.status": "Terminal status",
  "terminal.list": "Terminals",
  "terminal.close": "Closed terminal",
  "subagent.start": "Started agent",
  "subagent.read": "Agent report",
  "subagent.wait": "Waited for agents",
  "subagent.list": "Agents",
  "subagent.stop": "Stopped agent",
  "skill.load": "Loaded skill",
  "skill.list": "Skills",
  "mcp.call": "Called MCP tool",
};

export function toolUsageLabel(name: string, fallback = name): string {
  return Object.hasOwn(LABELS, name) ? LABELS[name]! : fallback;
}

const labels = Object.values(LABELS).sort((left, right) => right.length - left.length);
const labelPattern = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
export const TOOL_USAGE_LINE = new RegExp(`^(\\s*)([→✓✗])(\\s+)(${labelPattern}|[\\w-]+\\.[\\w.-]+)(?=\\s|$)(.*)$`);
