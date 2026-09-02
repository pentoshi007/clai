import { join } from "node:path";
import type { SessionPlan } from "../../store/plan.js";
import {
  discoverImmediateProjectRoots,
  guessProjectFolderName,
  isBareParentDirectory,
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
  readonly instructionScanInput: { cwd: string; projectRoot?: string };
}

export const orientTurnWorkspace = (input: {
  readonly prompt: string;
  readonly plan: SessionPlan | undefined;
  readonly cwd: string;
}): TurnOrientation => {
  const destinationHint = resolveUserDestinationHint(input.prompt);
  const orientationSourceText = [
    input.prompt,
    input.plan?.goal,
    input.plan?.detail,
    input.plan?.tasks.map((task) => task.title).join(" "),
  ]
    .filter(Boolean)
    .join("\n");
  const fromPlan = extractProjectRootFromPlan(input.plan);
  const fromPrompt = extractProjectRootFromText(input.prompt);
  const guessedName = guessProjectFolderName(orientationSourceText);
  const orientationParent =
    destinationHint ??
    (isBareParentDirectory(input.cwd) ? input.cwd : undefined);
  const guessedProject =
    orientationParent && guessedName
      ? join(orientationParent, guessedName)
      : undefined;

  let pinnedProject = false;
  for (const candidate of [fromPlan, fromPrompt, guessedProject]) {
    if (setActiveProjectRootIfValid(candidate)) {
      pinnedProject = true;
      break;
    }
  }
  if (!pinnedProject) {
    const discovered = orientationParent
      ? discoverImmediateProjectRoots(orientationParent)
      : [];
    if (discovered.length === 1) setActiveProjectRootIfValid(discovered[0]);
  }

  const projectRoot = getActiveProjectRoot();
  return {
    destinationHint,
    instructionScanInput: {
      cwd: input.cwd,
      ...(projectRoot ? { projectRoot } : {}),
    },
  };
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
