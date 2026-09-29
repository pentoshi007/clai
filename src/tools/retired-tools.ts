import type { ToolCall } from "../types.js";

const RETIRED_TOOL_GUIDANCE: Readonly<Record<string, string>> = {
  "tool.batch":
    "tool.batch was removed. Emit the calls directly in one response; independent read-only calls run in parallel.",
  "subagent.start_many":
    "subagent.start_many was removed. Call subagent.start once per assignment in the same response.",
  "subagent.restart":
    "subagent.restart was removed. Start a new subagent and pass the settled child's findings as context.",
  "terminal.resize":
    "terminal.resize was removed. Set columns and rows when calling terminal.start.",
  "pkg.install":
    "pkg.install was removed. Confirm the binary is missing with tool.check, then install it with shell.exec through the OS package manager.",
  sysinfo:
    "sysinfo was removed. OS, shell, and cwd are in REQUEST ENVIRONMENT; use shell.exec (uname -a, sw_vers, systeminfo) for anything else.",
};

const RETIRED_TOOL_UPGRADES: Readonly<Record<string, (args: Record<string, unknown>) => ToolCall>> = {
  "task.read": (args) => ({ name: "job.read", args }),
  "shell.start": (args) => ({ name: "shell.exec", args: { ...args, background: "always" } }),
};

const canonicalRetiredName = (name: string): string => {
  const trimmed = name.trim();
  if (trimmed in RETIRED_TOOL_GUIDANCE || trimmed in RETIRED_TOOL_UPGRADES) return trimmed;
  const dotted = [...Object.keys(RETIRED_TOOL_GUIDANCE), ...Object.keys(RETIRED_TOOL_UPGRADES)].find(
    (canonical) => canonical.replace(/\./g, "_") === trimmed,
  );
  return dotted ?? trimmed;
};

export const retiredToolGuidance = (name: string): string | undefined =>
  RETIRED_TOOL_GUIDANCE[canonicalRetiredName(name)];

export function upgradeRetiredToolCall(call: ToolCall): ToolCall {
  const upgrade = RETIRED_TOOL_UPGRADES[canonicalRetiredName(call.name)];
  return upgrade ? upgrade(call.args ?? {}) : call;
}
