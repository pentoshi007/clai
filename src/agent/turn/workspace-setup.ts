import { join } from "node:path";
import type { SessionPlan } from "../../store/plan.js";
import {
  classifyWorkIntent,
  discoverImmediateProjectRoots,
  guessProjectFolderName,
  isBareParentDirectory,
  type WorkIntent,
} from "../workspace-orient.js";
import { resolveUserDestinationHint } from "../task-evidence.js";
import {
  extractProjectRootFromPlan,
  extractProjectRootFromText,
  getActiveProjectRoot,
  setActiveProjectRootIfValid,
} from "../project-root.js";
import { loadAgentInstructions } from "../../instructions/load.js";
import { ensureProjectInstructionFiles } from "../../instructions/scaffold.js";
import { loadSkill } from "../../skills/registry.js";
import { skillMentionNames } from "../../skills/mentions.js";
import { renderActiveSkills } from "../../skills/catalog.js";
import type { LoadedSkill } from "../../skills/types.js";

export interface TurnOrientation {
  readonly destinationHint: string | undefined;
  readonly workIntent: WorkIntent;
  readonly instructionScanInput: { cwd: string; projectRoot?: string };
}

export const resolveTurnWorkIntent = (
  prompt: string,
  plan: SessionPlan | undefined,
): WorkIntent => {
  const fromPrompt = classifyWorkIntent(prompt);
  if (fromPrompt !== "unspecified" || !plan?.goal) return fromPrompt;
  return classifyWorkIntent(plan.goal);
};

interface TurnOrientationInput {
  readonly prompt: string;
  readonly plan: SessionPlan | undefined;
  readonly cwd: string;
}

export const orientTurnWorkspace = (
  input: TurnOrientationInput,
): TurnOrientation => {
  const destinationHint = resolveUserDestinationHint(input.prompt);
  const workIntent = resolveTurnWorkIntent(input.prompt, input.plan);
  const explicitRoots = [
    extractProjectRootFromPlan(input.plan),
    extractProjectRootFromText(input.prompt),
  ];
  const pinnedExplicitly = pinFirstValidRoot(explicitRoots);
  if (!pinnedExplicitly && workIntent !== "new") {
    pinInferredProject(input, destinationHint);
  }

  const projectRoot = getActiveProjectRoot();
  return {
    destinationHint,
    workIntent,
    instructionScanInput: {
      cwd: input.cwd,
      ...(projectRoot ? { projectRoot } : {}),
    },
  };
};

const pinFirstValidRoot = (candidates: readonly (string | undefined)[]): boolean => {
  for (const candidate of candidates) {
    if (setActiveProjectRootIfValid(candidate)) return true;
  }
  return false;
};

const pinInferredProject = (
  input: TurnOrientationInput,
  destinationHint: string | undefined,
): void => {
  const orientationParent =
    destinationHint ??
    (isBareParentDirectory(input.cwd) ? input.cwd : undefined);
  if (!orientationParent) return;
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
  const guessedProject = guessedName
    ? join(orientationParent, guessedName)
    : undefined;
  if (pinFirstValidRoot([guessedProject])) return;
  const discovered = discoverImmediateProjectRoots(orientationParent);
  if (discovered.length === 1) setActiveProjectRootIfValid(discovered[0]);
};

export interface TurnInstructions {
  readonly block: string | undefined;
  readonly skillsBlock: string | undefined;
  readonly selectedSkillNames: readonly string[];
  readonly refresh: () => Promise<string | undefined>;
}

export const loadTurnInstructions = async (input: {
  readonly prompt: string;
  readonly scanInput: { cwd: string; projectRoot?: string };
  readonly scaffoldInstructionFiles: boolean;
  readonly skillNames: ReadonlySet<string>;
  readonly notify: (level: "info" | "warn", message: string) => void;
}): Promise<TurnInstructions> => {
  if (input.scaffoldInstructionFiles) {
    const scaffold = await ensureProjectInstructionFiles(input.scanInput).catch(
      () => undefined,
    );
    if (scaffold && scaffold.created.length > 0) {
      input.notify(
        "info",
        `created ${scaffold.created.join(" and ")} — put your project rules in CLAI.md`,
      );
    }
  }
  const loaded = await loadAgentInstructions(input.scanInput).catch(
    () => undefined,
  );

  const selectedSkillNames = skillMentionNames(
    input.prompt,
    input.skillNames,
  );
  const activeSkills: LoadedSkill[] = [];
  for (const name of selectedSkillNames) {
    const skill = await loadSkill(name, input.scanInput).catch(() => undefined);
    if (skill) activeSkills.push(skill);
  }

  return {
    block: loaded?.block,
    skillsBlock: renderActiveSkills(activeSkills),
    selectedSkillNames,
    refresh: async () =>
      (await loadAgentInstructions(input.scanInput).catch(() => undefined))
        ?.block,
  };
};
