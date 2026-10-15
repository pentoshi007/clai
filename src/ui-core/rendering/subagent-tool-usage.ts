import { formatToolArgs } from "../../agent/parser/arg-formatting.js";
import { redactSecrets } from "../../llm/provider.js";
import { sanitizeDisplayText } from "./sanitize-display.js";
import { presentFsReadArgs } from "./tool-presenter.js";
import { toolUsageLabel } from "./tool-usage-label.js";

export function subagentReadUsage(paths: readonly { readonly path: string; readonly ok?: boolean }[]): string[] {
  return paths.map((file, index) => `${index === 0 ? "  └ " : "    "}Read ${file.ok === false ? "✗ " : ""}${sanitizeDisplayText(redactSecrets(file.path))}`);
}

function batchInput(args: Record<string, unknown>): string {
  const calls = Array.isArray(args.calls) ? args.calls : [];
  const labels = calls.flatMap((call: unknown) => {
    if (!call || typeof call !== "object" || !("name" in call) || typeof call.name !== "string") return [];
    return [toolUsageLabel(call.name)];
  });
  return `${calls.length} call(s)${labels.length ? `: ${labels.slice(0, 4).join(", ")}${labels.length > 4 ? ", …" : ""}` : ""}`;
}

export function subagentToolUsage(text: string): string | undefined {
  const match = /^Calling ([\w.-]+):\s*([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const name = match[1]!;
  const label = toolUsageLabel(name);
  let parsed: unknown;
  try { parsed = JSON.parse(match[2]!); } catch { return `→ ${label} [input unavailable]`; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return `→ ${label} [input unavailable]`;
  const args = parsed as Record<string, unknown>;
  const display = sanitizeDisplayText(redactSecrets(name === "tool.batch" ? batchInput(args) : formatToolArgs({ name, args })));
  if (name === "fs.read") {
    const read = presentFsReadArgs(display);
    return [`→ ${label}`, ...subagentReadUsage((read.files ?? [read]).filter(file => file.path))].join("\n");
  }
  const first = display.split("\n", 1)[0]?.trim() ?? "";
  return `→ ${label}${first ? ` ${first}` : ""}${display.includes("\n") ? " …" : ""}`;
}
