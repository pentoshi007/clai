
import type { ToolCall } from "../types.js";

export function describeToolCall(call: ToolCall): string {
  if (call.name === "shell.exec") return String(call.args.command ?? "");
  try {
    const json = JSON.stringify(call.args);
    return json.length > 120 ? `${json.slice(0, 117)}…` : json;
  } catch {
    return "";
  }
}

export function toolPromptText(call: ToolCall): string {
  const args = describeToolCall(call);
  return `Run ${call.name}${args ? ` ${args}` : ""}?`;
}

export function deletePromptText(
  path: string,
  options?: { viewHint?: boolean },
): string {
  const hint = options?.viewHint
    ? " Press v to view file contents first."
    : "";
  return `DELETE this path?\n${path}\n\nThis cannot be undone.${hint}`;
}

export const PENTEST_PROMPT_TEXT =
  "This is a security/pentest action. Confirm you are authorized to run it against this target.";

export function agentSwitchPromptText(info: {
  reason: string;
  tools: string[];
}): string {
  const tools = info.tools.length > 0 ? ` (${info.tools.join(", ")})` : "";
  const why = info.reason ? `${info.reason}\n\n` : "";
  return `${why}This needs agent mode${tools}, which ask mode can't do. Switch to agent mode and run it?`;
}
