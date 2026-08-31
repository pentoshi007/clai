import type { Mode } from "../../types.js";
import type { AgentPromptSection } from "../prompt-composer.js";
import { SKILLS_CATALOG_PREFIX } from "../../skills/catalog.js";

export interface PromptSectionInput {
  readonly systemSections: readonly string[];
  readonly selectedSkillNames: readonly string[];
  readonly prompt: string;
  readonly mode: Mode;
}

const KIND_RULES: ReadonlyArray<{
  readonly matches: (content: string) => boolean;
  readonly kind: AgentPromptSection["kind"];
}> = [
  { matches: (c) => c.startsWith(SKILLS_CATALOG_PREFIX), kind: "context" },
  { matches: (c) => c.startsWith("ACTIVE PLAN"), kind: "plan" },
  { matches: (c) => c.startsWith("ENGAGEMENT SCOPE"), kind: "scope" },
  { matches: (c) => c.includes("MODE"), kind: "mode" },
  { matches: (c) => c.includes("OUTCOME"), kind: "outcome" },
  {
    matches: (c) =>
      c.includes("WORKFLOW") ||
      c.includes("FOCUS") ||
      c.startsWith("WORK PROFILE"),
    kind: "focus",
  },
];

const sectionKind = (content: string): AgentPromptSection["kind"] =>
  KIND_RULES.find((rule) => rule.matches(content))?.kind ?? "context";

const MANDATORY_PREFIXES = [
  "ACTIVE PLAN",
  "MCP TOOL CONTEXT",
  "ENGAGEMENT SCOPE",
  "REQUEST ENVIRONMENT",
  "Project context from .clai/context.md:",
  "ACTIVE PROJECT ROOT:",
  "USER DESTINATION:",
  "WORKSPACE STATUS",
] as const;

const isMandatory = (content: string, hasSelectedSkills: boolean): boolean =>
  content.startsWith(SKILLS_CATALOG_PREFIX)
    ? hasSelectedSkills
    : MANDATORY_PREFIXES.some((prefix) => content.startsWith(prefix)) ||
      content.includes("MODE") ||
      content.includes("OUTCOME");

const outcomeContract = (prompt: string): AgentPromptSection => ({
  kind: "outcome",
  content: `OUTCOME CONTRACT\nGoal: ${prompt}\nDecide first what this request actually asks for: a question or doubt is satisfied by an accurate, grounded answer, while a directive to change something is satisfied only by the verified change. Success requires evidence that whichever of those the user asked for is delivered; otherwise return partial, blocked, failed, aborted, or paused_budget with remaining criteria.`,
  mandatory: true,
});

const planProtocol: AgentPromptSection = {
  kind: "plan",
  content:
    "PLAN PROTOCOL\nThe live plan, when one exists, is appended to this request as a single ACTIVE PLAN message. Treat that message as the only authoritative plan state; never rely on plan details quoted in earlier turns.",
  mandatory: true,
};

const emptyScope: AgentPromptSection = {
  kind: "scope",
  content:
    "ENGAGEMENT SCOPE\nNo active remote-security scope applies to this turn.",
  mandatory: true,
};

export const buildPromptSections = (
  input: PromptSectionInput,
): AgentPromptSection[] => {
  const hasSelectedSkills = input.selectedSkillNames.length > 0;
  const sections: AgentPromptSection[] = input.systemSections.map(
    (content) => ({
      kind: sectionKind(content),
      content,
      mandatory: isMandatory(content, hasSelectedSkills),
    }),
  );
  const has = (kind: AgentPromptSection["kind"]): boolean =>
    sections.some((section) => section.kind === kind);
  if (!has("outcome")) sections.push(outcomeContract(input.prompt));
  if (!has("plan")) sections.push(planProtocol);
  if (!has("scope")) sections.push(emptyScope);
  sections.push({
    kind: "context",
    content: `TASK STATE\nMode: ${input.mode}. Current request: ${input.prompt}`,
    mandatory: true,
  });
  return sections;
};
