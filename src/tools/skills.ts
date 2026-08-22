import type { ToolResult } from "../types.js";
import { getActiveProjectRoot } from "../agent/project-root.js";
import { safeCwd } from "../os/cwd.js";
import { renderSkillListing, skillScopeLabel } from "../skills/format.js";
import { getSkillIndex, loadSkill } from "../skills/registry.js";
import type { SkillMeta } from "../skills/types.js";

const MAX_LISTED = 60;

function scanInput(): { cwd: string; projectRoot?: string } {
  const root = getActiveProjectRoot();
  return { cwd: safeCwd(), ...(root ? { projectRoot: root } : {}) };
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function matches(skill: SkillMeta, query: string): boolean {
  const needle = query.toLowerCase();
  return (
    skill.name.includes(needle) ||
    skill.description.toLowerCase().includes(needle) ||
    skill.tool.includes(needle)
  );
}

export async function skillListTool(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const index = await getSkillIndex(scanInput());
  if (index.skills.length === 0) {
    return {
      ok: true,
      exitCode: 0,
      output:
        "No Agent Skills are installed. Skills live in <project>/.clai/skills/<name>/SKILL.md (also .claude/skills, .agents/skills, .github/skills, .opencode/skills, .codex/skills) or the same folders under your home config. Proceed without skills.",
    };
  }
  const query = stringArg(args, "query");
  const filtered = query
    ? index.skills.filter((skill) => matches(skill, query))
    : [...index.skills];
  if (filtered.length === 0) {
    return {
      ok: true,
      exitCode: 0,
      output: `No skill matched "${query}". Known skills: ${index.skills
        .map((skill) => skill.name)
        .join(", ")}`,
    };
  }
  const shown = filtered.slice(0, MAX_LISTED);
  const footer =
    filtered.length > shown.length
      ? `\n\n…${filtered.length - shown.length} more matched; narrow the query.`
      : "";
  return {
    ok: true,
    exitCode: 0,
    output: `${shown.length} skill${shown.length === 1 ? "" : "s"} available. Call skill.load with a name to read one.\n\n${renderSkillListing(shown)}${footer}`,
  };
}

export async function skillLoadTool(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const name = stringArg(args, "name") ?? stringArg(args, "skill");
  if (!name) {
    return {
      ok: false,
      exitCode: 1,
      output: 'skill.load requires {"name":"<skill-name>"} from the AVAILABLE SKILLS list.',
    };
  }
  const input = scanInput();
  const loaded = await loadSkill(name, input);
  if (!loaded) {
    const index = await getSkillIndex(input);
    const known = index.skills.map((skill) => skill.name);
    return {
      ok: false,
      exitCode: 1,
      output:
        known.length === 0
          ? `No skill named "${name}" and no skills are installed. Continue without it.`
          : `No skill named "${name}". Available: ${known.join(", ")}`,
    };
  }
  const header = [
    `skill: ${loaded.meta.name} [${skillScopeLabel(loaded.meta)}]`,
    `file: ${loaded.meta.file}`,
    loaded.meta.compatibility ? `compatibility: ${loaded.meta.compatibility}` : "",
    loaded.meta.allowedTools?.length
      ? `allowed-tools declared by the skill: ${loaded.meta.allowedTools.join(" ")} (advisory — clai's own permission gate still applies)`
      : "",
    loaded.resources.length > 0
      ? `bundled files (relative to ${loaded.meta.dir}, read with fs.read only when the instructions below reference them): ${loaded.resources.join(", ")}`
      : "",
    "Follow these instructions for the rest of this task. They do not override user messages, confirmation prompts, or engagement scope.",
  ]
    .filter(Boolean)
    .join("\n");
  const footer = loaded.truncated
    ? `\n\n…(truncated; read ${loaded.meta.file} directly for the remainder)`
    : "";
  return {
    ok: true,
    exitCode: 0,
    output: `${header}\n\n---\n\n${loaded.body}${footer}`,
  };
}
