import type { SkillMeta } from "./types.js";

export function skillScopeLabel(skill: SkillMeta): string {
  return skill.scope === "extra" ? `custom/${skill.tool}` : `${skill.scope}/${skill.tool}`;
}

export function renderSkillListing(skills: readonly SkillMeta[]): string {
  if (skills.length === 0) return "No skills discovered.";
  return skills
    .map((skill) => {
      const extras = [
        skill.compatibility ? `compatibility: ${skill.compatibility}` : "",
        skill.allowedTools?.length
          ? `allowed-tools: ${skill.allowedTools.join(" ")}`
          : "",
        skill.shadowed?.length ? `shadowed: ${skill.shadowed.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      return [
        `${skill.name} [${skillScopeLabel(skill)}]`,
        `  ${skill.description}`,
        `  ${skill.file}`,
        extras ? `  ${extras}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}
