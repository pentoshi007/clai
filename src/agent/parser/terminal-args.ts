import type { ToolCall } from "../../types.js";
import { redactSecrets } from "../../llm/provider.js";

export function formatTerminalArgs(call: ToolCall): string | undefined {
  if (!call.name.startsWith("terminal.")) return undefined;
  const { args } = call;
  if (call.name === "terminal.start") return redactSecrets(String(args.command ?? ""));
  if (call.name === "terminal.list") return "";
  const fields: string[] = [];
  if (call.name === "terminal.send") {
    switch (args.kind) {
      case "text":
        fields.push(`text=${redactSecrets(JSON.stringify(args.text ?? ""))}`);
        break;
      case "secret":
        fields.push("secret=[local input]");
        break;
      case "control":
        fields.push(`control=${String(args.control ?? "")}`);
        break;
      case "eof":
        fields.push("eof");
        break;
      default:
        fields.push(`kind=${String(args.kind ?? "")}`);
    }
    if (args.submit === "none") fields.push("submit=none");
  }
  for (const key of ["cursor", "waitMs", "quietMs", "deadlineMs", "view"] as const) {
    const value = args[key];
    if (typeof value === "string" || typeof value === "number") fields.push(`${key}=${value}`);
  }
  fields.push(`id=${String(args.id ?? "")}`);
  return fields.join(" · ");
}

export function restoredTerminalArgs(name: string, display: string): string {
  if (!name.startsWith("terminal.") || !display.trimStart().startsWith("{")) return display;
  try {
    const parsed: unknown = JSON.parse(display);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return display;
    return formatTerminalArgs({ name, args: parsed as Record<string, unknown> }) ?? display;
  } catch {
    return display;
  }
}
