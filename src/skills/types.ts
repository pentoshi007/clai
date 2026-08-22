export type SkillScope = "project" | "user" | "extra";

export interface SkillRoot {
  readonly path: string;
  readonly tool: string;
  readonly scope: SkillScope;
}

export interface SkillMeta {
  readonly name: string;
  readonly description: string;
  readonly dir: string;
  readonly file: string;
  readonly scope: SkillScope;
  readonly tool: string;
  readonly root: string;
  readonly compatibility?: string | undefined;
  readonly license?: string | undefined;
  readonly allowedTools?: readonly string[] | undefined;
  readonly shadowed?: readonly string[] | undefined;
}

export interface SkillIndex {
  readonly skills: readonly SkillMeta[];
  readonly roots: readonly SkillRoot[];
  readonly names: ReadonlySet<string>;
  readonly scannedAt: number;
  readonly truncated: boolean;
}

export interface LoadedSkill {
  readonly meta: SkillMeta;
  readonly body: string;
  readonly resources: readonly string[];
  readonly truncated: boolean;
}

export const EMPTY_SKILL_INDEX: SkillIndex = {
  skills: [],
  roots: [],
  names: new Set<string>(),
  scannedAt: 0,
  truncated: false,
};
