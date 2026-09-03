import type { ChatImage, ChatMessage, Mode } from "../../../types.js";
import type { SessionPlan } from "../../../store/plan.js";
import type { AgentPromptSection } from "../../prompt-composer.js";
import { buildPromptSections } from "../prompt-sections.js";
import { composeAgentSystemPrompt } from "../../prompt-composer.js";
import { assembleTurnMessages } from "../message-assembly.js";
import { planContextMessage, upsertPlanContextMessage } from "../../plan-tool.js";
import {
  upsertActiveSkillsMessage,
  upsertAgentInstructionsMessage,
} from "../../injected-blocks.js";
import { upsertRequestContextMessage } from "../../../llm/system-messages.js";

export interface TurnMessagesInput {
  readonly prompt: string;
  readonly displayPrompt: string | null | undefined;
  readonly images: ChatImage[] | undefined;
  readonly history: ChatMessage[] | undefined;
  readonly mode: Mode;
  readonly systemSections: readonly string[];
  readonly selectedSkillNames: readonly string[];
  readonly nativeToolsActive: boolean;
  readonly inputTokenBudget: number | undefined;
  readonly stableSystemContent: (native: boolean) => string;
  readonly instructionsBlock: string | undefined;
  readonly skillsBlock: string | undefined;
  readonly plan: SessionPlan | undefined;
  readonly planApproved: boolean;
}

export interface TurnMessages {
  readonly messages: ChatMessage[];
  readonly requestContextMessage: string;
  readonly promptSections: () => AgentPromptSection[];
}

export const dropSectionsAlreadyInHistory = (
  sections: readonly AgentPromptSection[],
  history: readonly ChatMessage[] | undefined,
  prompt: string,
): AgentPromptSection[] => {
  if (!history?.length || !prompt) return [...sections];
  const sent = history
    .map((message) => message.content)
    .filter((content): content is string => typeof content === "string");
  if (sent.length === 0) return [...sections];
  const kept = sections.filter(
    (section) =>
      section.content.includes(prompt) ||
      !sent.some((prior) => prior.includes(section.content)),
  );
  return kept.length > 0 ? kept : [...sections];
};

export const composeTurnMessages = (input: TurnMessagesInput): TurnMessages => {
  const promptSections = (): AgentPromptSection[] =>
    buildPromptSections({
      systemSections: input.systemSections,
      selectedSkillNames: input.selectedSkillNames,
      prompt: input.prompt,
      mode: input.mode,
    });
  const requestContext = composeAgentSystemPrompt({
    mode: input.mode,
    nativeToolsActive: input.nativeToolsActive,
    maxTokens: input.inputTokenBudget
      ? Math.min(2_000, Math.floor(input.inputTokenBudget * 0.4))
      : undefined,
    sections: dropSectionsAlreadyInHistory(
      promptSections(),
      input.history,
      input.prompt,
    ),
  }).content;
  const { messages, requestContextMessage } = assembleTurnMessages({
    prompt: input.prompt,
    displayPrompt: input.displayPrompt,
    images: input.images,
    history: input.history,
    systemPrompt: input.stableSystemContent(input.nativeToolsActive),
    requestContext,
  });
  upsertRequestContextMessage(messages, requestContextMessage);
  upsertAgentInstructionsMessage(messages, input.instructionsBlock);
  upsertActiveSkillsMessage(messages, input.skillsBlock);
  if (input.plan) {
    upsertPlanContextMessage(
      messages,
      planContextMessage(input.plan, input.planApproved),
    );
  }
  return { messages, requestContextMessage, promptSections };
};
