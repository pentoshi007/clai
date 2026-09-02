import type { Mode } from "../types.js";
import { estimateTextTokens } from "./request-accounting.js";

export type PromptSectionKind =
  | "safety"
  | "mode"
  | "outcome"
  | "plan"
  | "scope"
  | "recovery"
  | "focus"
  | "constitution"
  | "context";

export interface AgentPromptSection {
  readonly kind: PromptSectionKind;
  readonly content: string;
  readonly mandatory?: boolean;
}

export interface AgentPromptContext {
  readonly mode: Mode;
  readonly nativeToolsActive: boolean;
  readonly sections: readonly AgentPromptSection[];
  readonly maxTokens?: number | undefined;
}

export interface ComposedPrompt {
  readonly content: string;
  readonly included: readonly PromptSectionKind[];
  readonly omitted: readonly PromptSectionKind[];
  readonly estimatedTokens: number;
}

const priority: Record<PromptSectionKind, number> = {
  constitution: 0,
  safety: 1,
  mode: 2,
  recovery: 3,
  focus: 4,
  plan: 5,
  scope: 6,
  outcome: 7,
  context: 8,
};

export function composeAgentSystemPrompt(ctx: AgentPromptContext): ComposedPrompt {
  const modeSection: AgentPromptSection = {
    kind: "mode",
    mandatory: true,
    content: `CURRENT MODE: ${ctx.mode.toUpperCase()}\nMode is authoritative for this request.`,
  };
  const ordered = [modeSection, ...ctx.sections]
    .filter((section) => section.content.trim().length > 0)
    .sort((a, b) => priority[a.kind] - priority[b.kind]);
  const selected: AgentPromptSection[] = [];
  const omitted: PromptSectionKind[] = [];
  const maxSectionTokens = ctx.maxTokens ?? Number.POSITIVE_INFINITY;
  let used = 0;

  for (const section of ordered) {
    const size = estimateTextTokens(section.content) + (selected.length === 0 ? 0 : 1);
    if (section.mandatory || used + size <= maxSectionTokens) {
      selected.push(section);
      used += size;
    } else {
      omitted.push(section.kind);
    }
  }

  const content = selected.map((section) => section.content).join("\n\n");
  return {
    content,
    included: selected.map((section) => section.kind),
    omitted,
    estimatedTokens: estimateTextTokens(content),
  };
}
