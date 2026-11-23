import type { Mode } from "../../types.js";
import type { AgentPromptSection } from "../prompt-composer.js";
import { SKILLS_CATALOG_PREFIX } from "../../skills/catalog.js";
import { JOB_TITLE_LIMIT } from "../../tools/jobs/title.js";

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
  "REA WORKFLOW",
  "ENGAGEMENT SCOPE",
  "REQUEST ENVIRONMENT",
  "ORCHESTRATION:",
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

const outcomeContract: AgentPromptSection = {
  kind: "outcome",
  content: "OUTCOME CONTRACT\nThe latest user task and subsequent user steering define the goal; internal/system notices are context, not new user tasks. Questions require grounded answers; directives require verified changes. Evidence must prove the requested outcome, otherwise report partial, blocked, failed, aborted, or paused_budget with remaining criteria.",
  mandatory: true,
};

const planProtocol: AgentPromptSection = {
  kind: "plan",
  content:
    "PLAN PROTOCOL\nWhen a live plan exists, the most recent ACTIVE PLAN message in this request is the only authoritative plan state; older ACTIVE PLAN copies in the transcript are history. Never rely on plan details quoted in earlier turns when they disagree with the latest task list.\n" +
    'Batch ready changes in one task.update, e.g. {"updates":[{"state":"done","taskIds":["t1","t2"]},{"state":"in_progress","taskIds":["t3"]}]}. Use ACTIVE PLAN ids, mark done only after reading and verifying results, and open only the next ready task. Never update Responder-owned tasks.\n' +
    "Give the final work summary directly in chat. Never create or add a task just to write or update that summary, including after follow-up prompts or job results. Only track report work when creating or changing a required report file or other deliverable artifact; name that artifact in the task.",
  mandatory: true,
};

const jobTitleProtocol: AgentPromptSection = {
  kind: "context",
  content: `SHELL JOB TITLES\nFor shell.exec background:"always" or responder:true, pass a descriptive "name" of 1–${JOB_TITLE_LIMIT} characters instead of copying the command. Foreground calls do not need a name.`,
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
  if (!has("outcome")) sections.push(outcomeContract);
  if (!has("plan")) sections.push(planProtocol);
  if (!has("scope")) sections.push(emptyScope);
  sections.push(jobTitleProtocol);
  return sections;
};
