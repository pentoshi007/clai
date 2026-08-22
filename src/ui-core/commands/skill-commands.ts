import type { AppServices } from "../bootstrap/composition-root.js";
import type { CommandInvocation } from "../../app/commands/command.js";
import { composerActionPort } from "../composer/composer-action-port.js";
import { renderSkillListing, skillScopeLabel } from "../../skills/format.js";
import { getSkillIndex, invalidateSkillIndex } from "../../skills/registry.js";
import { skillSearchLocationHints } from "../../skills/locations.js";
import { formatSkillToken } from "../../skills/mentions.js";
import type { SkillMeta } from "../../skills/types.js";
import { safeCwd } from "../../os/cwd.js";

const NO_SKILLS_HINT = `no skills found — add <project>/.clai/skills/<name>/SKILL.md (also read from ${skillSearchLocationHints()
  .slice(1, 8)
  .join(", ")} and your home config)`;

function attach(services: AppServices, skill: SkillMeta): void {
  const token = formatSkillToken(skill.name);
  if (composerActionPort.insert(`${token} `)) {
    services.focus.focusRegion("composer");
    return;
  }
  services.session.notice(
    "info",
    `type ${token} in your prompt to load this skill for that request`,
  );
}

export async function handleSkills(
  services: AppServices,
  invocation: CommandInvocation,
): Promise<void> {
  const args = invocation.args.trim();
  const sub = args.toLowerCase();
  if (sub === "refresh" || sub === "reload") invalidateSkillIndex();
  const index = await getSkillIndex({ cwd: safeCwd() });

  if (index.skills.length === 0) {
    services.session.notice("info", NO_SKILLS_HINT);
    return;
  }

  if (sub === "list" || sub === "all") {
    services.overlay.openPager(
      `Skills (${index.skills.length})`,
      renderSkillListing(index.skills),
      undefined,
      undefined,
      "plain",
    );
    return;
  }

  if (args && sub !== "refresh" && sub !== "reload") {
    const needle = sub;
    const exact = index.skills.find((skill) => skill.name === needle);
    if (exact) {
      attach(services, exact);
      return;
    }
    const partial = index.skills.filter((skill) => skill.name.includes(needle));
    if (partial.length === 1) {
      attach(services, partial[0]!);
      return;
    }
    if (partial.length === 0) {
      services.session.notice(
        "warn",
        `no skill matching "${args}" · ${index.skills.map((s) => s.name).join(", ")}`,
      );
      return;
    }
  }

  const filter = args && sub !== "refresh" && sub !== "reload" ? sub : "";
  const pool = filter
    ? index.skills.filter((skill) => skill.name.includes(filter))
    : index.skills;
  services.overlay.openPicker(
    {
      title: `Skills · ${pool.length} available`,
      searchDescription: true,
      twoLine: true,
      options: pool.map((skill) => ({
        value: skill.name,
        label: formatSkillToken(skill.name),
        description: `${skill.description} — ${skillScopeLabel(skill)}`,
      })),
    },
    (value) => {
      const picked = pool.find((skill) => skill.name === value);
      services.overlay.close();
      if (picked) attach(services, picked);
    },
  );
}
