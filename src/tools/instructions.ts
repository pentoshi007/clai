import type { ToolResult } from "../types.js";
import { getActiveProjectRoot } from "../agent/project-root.js";
import { safeCwd } from "../os/cwd.js";
import { recordInstructions } from "../instructions/record.js";

const MAX_ENTRIES_PER_CALL = 12;

function stringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (typeof value === "string") return value.trim() ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, MAX_ENTRIES_PER_CALL);
}

export async function instructionsRecordTool(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const add = stringArray(args, "add");
  const remove = stringArray(args, "remove");
  if (add.length === 0 && remove.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      output:
        'instructions.record requires {"add":["<standing rule>"]} and/or {"remove":["<existing rule>"]}. One short imperative sentence per entry.',
    };
  }
  const root = getActiveProjectRoot();
  const result = await recordInstructions({
    cwd: safeCwd(),
    ...(root ? { projectRoot: root } : {}),
    ...(add.length > 0 ? { add } : {}),
    ...(remove.length > 0 ? { remove } : {}),
  });
  if (!result) {
    return {
      ok: false,
      exitCode: 1,
      output:
        "Cannot record instructions here: the working directory is the home directory or the global clai config directory. Keep following the rule for this session and mention it in your reply instead.",
    };
  }
  const lines = [
    `${result.path} updated.`,
    result.added.length > 0 ? `added: ${result.added.join(" | ")}` : "",
    result.removed.length > 0 ? `removed: ${result.removed.join(" | ")}` : "",
    result.dropped > 0
      ? `dropped ${result.dropped} oldest entr${result.dropped === 1 ? "y" : "ies"} (40 max)`
      : "",
    `active rules now (${result.active.length}):`,
    ...result.active.map((entry, index) => `  ${index + 1}. ${entry}`),
    "This file is re-read every turn and re-injected after compaction. Keep obeying these rules without being reminded, and do not call this tool again for the same rule.",
  ].filter(Boolean);
  return { ok: true, exitCode: 0, output: lines.join("\n") };
}
