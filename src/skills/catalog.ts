import { estimateTextTokens } from "../agent/request-accounting.js";
import type { LoadedSkill, SkillMeta } from "./types.js";

export const SKILLS_CATALOG_PREFIX = "AVAILABLE SKILLS";
export const ACTIVE_SKILLS_PREFIX = "ACTIVE SKILLS";

const CATALOG_TOKEN_BUDGET = 700;
const CATALOG_MIN_ENTRIES = 6;
const ACTIVE_SKILL_TOKEN_BUDGET = 12_000;
const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "for",
  "from", "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "of",
  "on", "or", "our", "please", "so", "than", "that", "the", "then", "there",
  "these", "this", "to", "up", "use", "used", "using", "want", "was", "we",
  "what", "when", "which", "will", "with", "you", "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function scoreSkill(promptTokens: readonly string[], skill: SkillMeta): number {
  if (promptTokens.length === 0) return 0;
  const nameTokens = new Set(skill.name.split("-"));
  const descriptionTokens = new Set(tokenize(skill.description));
  let score = 0;
  for (const token of promptTokens) {
    if (nameTokens.has(token)) score += 6;
    else if (skill.name.includes(token)) score += 4;
    if (descriptionTokens.has(token)) score += 2;
    else if (skill.description.toLowerCase().includes(token)) score += 1;
  }
  return score;
}

export function rankSkills(
  prompt: string,
  skills: readonly SkillMeta[],
  pinned: readonly string[] = [],
): SkillMeta[] {
  const promptTokens = tokenize(prompt);
  const pinnedSet = new Set(pinned);
  return [...skills].sort((a, b) => {
    const pinnedDelta = Number(pinnedSet.has(b.name)) - Number(pinnedSet.has(a.name));
    if (pinnedDelta !== 0) return pinnedDelta;
    const scoreDelta = scoreSkill(promptTokens, b) - scoreSkill(promptTokens, a);
    if (scoreDelta !== 0) return scoreDelta;
    return a.name.localeCompare(b.name);
  });
}

function catalogLine(skill: SkillMeta): string {
  const scope = skill.scope === "project" ? "project" : skill.scope === "user" ? "user" : "custom";
  return `- ${skill.name} [${scope}]: ${skill.description}`;
}

export function renderSkillCatalog(input: {
  readonly skills: readonly SkillMeta[];
  readonly prompt: string;
  readonly pinned?: readonly string[] | undefined;
  readonly truncatedScan?: boolean | undefined;
  readonly maxTokens?: number | undefined;
}): string | undefined {
  if (input.skills.length === 0) return undefined;
  const pinned = input.pinned ?? [];
  const ranked = rankSkills(input.prompt, input.skills, pinned);
  const budget = input.maxTokens ?? CATALOG_TOKEN_BUDGET;
  const header = [
    SKILLS_CATALOG_PREFIX,
    "Reusable expert procedures found in this workspace and your config. Only metadata is listed here.",
    "Before starting work that one of these descriptions covers, call skill.load with its name and follow the loaded instructions. Never guess a skill body, and never load a skill unrelated to the task. Ignore this block entirely when no description matches.",
  ].join("\n");

  const lines: string[] = [];
  let used = estimateTextTokens(header);
  let omitted = 0;
  for (const skill of ranked) {
    const line = catalogLine(skill);
    const cost = estimateTextTokens(line) + 1;
    const forced = pinned.includes(skill.name) || lines.length < CATALOG_MIN_ENTRIES;
    if (!forced && used + cost > budget) {
      omitted += 1;
      continue;
    }
    lines.push(line);
    used += cost;
  }

  const footer: string[] = [];
  if (omitted > 0 || input.truncatedScan) {
    footer.push(
      `${omitted > 0 ? `${omitted} more skill${omitted === 1 ? "" : "s"} not listed here. ` : ""}Call skill.list to see the full set.`,
    );
  }
  return [header, ...lines, ...footer].join("\n");
}

export function renderActiveSkills(loaded: readonly LoadedSkill[]): string | undefined {
  if (loaded.length === 0) return undefined;
  const header = [
    ACTIVE_SKILLS_PREFIX,
    `The user selected ${loaded.length === 1 ? "this skill" : "these skills"} for this request with skill:<name>. Follow the instructions below for the whole turn; they are already loaded, so do not call skill.load for them.`,
  ].join("\n");
  const blocks: string[] = [];
  let used = estimateTextTokens(header);
  for (const entry of loaded) {
    const resources =
      entry.resources.length > 0
        ? `\nBundled files (read with fs.read when the instructions reference them, paths relative to ${entry.meta.dir}): ${entry.resources.join(", ")}`
        : "";
    const block = [
      `--- skill: ${entry.meta.name} (${entry.meta.file}) ---`,
      entry.body,
      entry.truncated ? "…(skill body truncated; read the file directly for the rest)" : "",
      resources.trim(),
    ]
      .filter(Boolean)
      .join("\n");
    const cost = estimateTextTokens(block);
    if (used + cost > ACTIVE_SKILL_TOKEN_BUDGET && blocks.length > 0) {
      blocks.push(
        `--- skill: ${entry.meta.name} (${entry.meta.file}) ---\nNot inlined (turn budget reached). Call skill.load with name "${entry.meta.name}" if you need it.`,
      );
      continue;
    }
    blocks.push(block);
    used += cost;
  }
  return [header, ...blocks].join("\n\n");
}

export { renderSkillListing } from "./format.js";
