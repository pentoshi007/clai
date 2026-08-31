import { join } from "node:path";
import type { ChatMessage, Mode } from "../../types.js";
import type { BackgroundJob } from "../../tools/jobs.js";
import type { SessionPlan } from "../../store/plan.js";
import type { SkillMeta } from "../../skills/types.js";
import { renderRequestEnvironmentContext } from "../../prompts/index.js";
import {
  agentModeDirective,
  planModeDirective,
} from "../../prompts/index.js";
import { renderSkillCatalog } from "../../skills/catalog.js";
import { loadScopeForSession } from "../../store/scope.js";
import { safeCwd } from "../../os/cwd.js";
import { analyzeTask, formatTaskAnalysisHint } from "../task-analyzer.js";
import {
  buildContinueOrientation,
  type PreviousTurnSignal,
} from "../continue-orient.js";
import {
  buildWorkflowDirective,
  narrowNmapOperationDirective,
  pentestNoLocalServerDirective,
  pentestWorkflowDirective,
} from "../tool-call-parser.js";
import {
  extractProjectRootFromPlan,
  extractProjectRootFromText,
} from "../project-root.js";
import {
  buildWorkspaceOrientation,
  guessProjectFolderName,
} from "../workspace-orient.js";
import { scopeContextMessage } from "../scope-context.js";

export interface SystemSectionInput {
  readonly prompt: string;
  readonly mode: Mode;
  readonly plan: SessionPlan | undefined;
  readonly history: readonly ChatMessage[] | undefined;
  readonly previousTurn: PreviousTurnSignal | undefined;
  readonly sessionId: string;
  readonly projectContext: string | undefined;
  readonly destinationHint: string | undefined;
  readonly isPlanMode: boolean;
  readonly buildLikeTurn: boolean;
  readonly informationalQuery: boolean;
  readonly idleOrSocialPrompt: boolean;
  readonly narrowNmapOperation: boolean;
  readonly pentestLikeTurn: boolean;
  readonly skillsAvailable: boolean;
  readonly skillIndex: {
    readonly skills: readonly SkillMeta[];
    readonly truncated: boolean;
  };
  readonly selectedSkillNames: readonly string[];
  readonly inputTokenBudget: number | undefined;
  readonly getMcpContext: () => string | undefined;
  readonly getProjectRoot: () => string | undefined;
  readonly getRunningJobs: () => readonly BackgroundJob[];
  readonly getRecentJobs: () => readonly BackgroundJob[];
}

const PROJECT_ROOT_RULES =
  "All relative paths (./src/…, manifests, configs) resolve under this directory — NOT the agent process cwd. " +
  "Prefer absolute paths under this root. shell cwd for install / run / build must be this root " +
  "(or its parent when creating a NEW named subfolder with a scaffolder). " +
  "Never write user app source into the agent package tree.";

const DESTINATION_RULES =
  "Pick or detect a project subfolder; do not scaffold into the agent working tree unless the user asked for that.";

const locationSection = (
  input: SystemSectionInput,
  projectRoot: string | undefined,
): string | undefined => {
  if (projectRoot) {
    return `ACTIVE PROJECT ROOT: ${projectRoot}\n${PROJECT_ROOT_RULES}`;
  }
  if (input.destinationHint) {
    return `USER DESTINATION: create or continue work under "${input.destinationHint}" (parent folder). ${DESTINATION_RULES}`;
  }
  return undefined;
};

const workspaceSection = (input: SystemSectionInput): string => {
  const guessedName = guessProjectFolderName(
    [
      input.prompt,
      input.plan?.goal,
      input.plan?.detail,
      input.plan?.tasks.map((task) => task.title).join(" "),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const extraPaths: string[] = [];
  if (input.destinationHint && guessedName) {
    extraPaths.push(join(input.destinationHint, guessedName));
  }
  const fromText =
    extractProjectRootFromPlan(input.plan) ??
    extractProjectRootFromText(input.prompt);
  if (fromText) extraPaths.push(fromText);
  const orientInput: {
    cwd: string;
    destinationHint?: string;
    candidateProject?: string;
    extraPaths: string[];
  } = { cwd: safeCwd(), extraPaths };
  if (input.destinationHint) orientInput.destinationHint = input.destinationHint;
  const candidate = input.getProjectRoot() ?? fromText;
  if (candidate) orientInput.candidateProject = candidate;
  return buildWorkspaceOrientation(orientInput);
};

const continuationSection = (input: SystemSectionInput): string =>
  buildContinueOrientation({
    prompt: input.prompt,
    history: input.history,
    plan: input.plan,
    runningJobs: input.getRunningJobs(),
    recentJobs: input.getRecentJobs(),
    informationalQuery: input.informationalQuery,
    idleOrSocial: input.idleOrSocialPrompt,
    ...(input.previousTurn ? { previousTurn: input.previousTurn } : {}),
  });

const isPentestSession = (input: SystemSectionInput): boolean =>
  input.pentestLikeTurn ||
  input.plan?.kind === "pentest" ||
  (input.plan?.kind !== "coding" &&
    Boolean(
      input.plan?.goal &&
        /pentest|vulnerab|recon|security assess|attack surface|red team/i.test(
          input.plan.goal,
        ),
    ));

const workflowSections = (input: SystemSectionInput): string[] => {
  const sections: string[] = [];
  const workNotIdle =
    input.buildLikeTurn && !input.informationalQuery && !input.idleOrSocialPrompt;
  if (input.isPlanMode) {
    sections.push(planModeDirective());
  } else if (input.mode === "agent") {
    sections.push(agentModeDirective());
  }
  if (workNotIdle && !input.isPlanMode) sections.push(buildWorkflowDirective());
  if (input.isPlanMode && workNotIdle) sections.push(buildWorkflowDirective());
  if (
    input.narrowNmapOperation &&
    !input.informationalQuery &&
    !input.idleOrSocialPrompt &&
    !input.isPlanMode
  ) {
    sections.push(narrowNmapOperationDirective());
  }
  if (
    input.pentestLikeTurn &&
    !input.narrowNmapOperation &&
    !input.plan &&
    !input.informationalQuery &&
    !input.idleOrSocialPrompt
  ) {
    sections.push(pentestWorkflowDirective());
  }
  return sections;
};

const scopeSection = async (
  input: SystemSectionInput,
  pentestSession: boolean,
): Promise<string | undefined> => {
  const engagementScope = await loadScopeForSession(input.sessionId).catch(
    () => undefined,
  );
  const scopeBlock = scopeContextMessage(engagementScope);
  return scopeBlock &&
    (pentestSession || input.pentestLikeTurn) &&
    !input.idleOrSocialPrompt
    ? scopeBlock
    : undefined;
};

const taskAnalysisSection = (input: SystemSectionInput): string | undefined => {
  const analysis = analyzeTask(input.prompt);
  const wanted =
    analysis.shouldPlan ||
    analysis.complexity === "complex" ||
    input.buildLikeTurn ||
    input.pentestLikeTurn;
  return !input.idleOrSocialPrompt &&
    !input.informationalQuery &&
    !input.narrowNmapOperation &&
    wanted
    ? formatTaskAnalysisHint(analysis)
    : undefined;
};

const skillCatalogSection = (
  input: SystemSectionInput,
): string | undefined =>
  input.skillsAvailable && !input.idleOrSocialPrompt
    ? renderSkillCatalog({
        skills: input.skillIndex.skills,
        prompt: input.prompt,
        pinned: input.selectedSkillNames,
        truncatedScan: input.skillIndex.truncated,
        ...(input.inputTokenBudget ? { maxTokens: 260 } : {}),
      })
    : undefined;

export const buildSystemSections = async (
  input: SystemSectionInput,
): Promise<{
  readonly sections: string[];
  readonly pentestSession: boolean;
}> => {
  const sections: string[] = [
    renderRequestEnvironmentContext({ plan: input.plan }),
  ];
  const push = (section: string | undefined): void => {
    if (section) sections.push(section);
  };
  push(input.getMcpContext());
  if (input.projectContext) {
    push(`Project context from .clai/context.md:\n${input.projectContext}`);
  }
  push(locationSection(input, input.getProjectRoot()));
  if (
    input.buildLikeTurn &&
    !input.informationalQuery &&
    !input.idleOrSocialPrompt
  ) {
    sections.push(workspaceSection(input));
  }
  if (!input.informationalQuery && !input.idleOrSocialPrompt) {
    push(continuationSection(input));
  }
  sections.push(...workflowSections(input));
  const pentestSession = isPentestSession(input);
  if (pentestSession && !input.idleOrSocialPrompt) {
    sections.push(pentestNoLocalServerDirective());
  }
  push(await scopeSection(input, pentestSession));
  push(taskAnalysisSection(input));
  push(skillCatalogSection(input));
  return { sections, pentestSession };
};
