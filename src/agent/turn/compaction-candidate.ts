import type { ChatMessage } from "../../types.js";
import type { SessionPlan } from "../../store/plan.js";
import {
  upsertActiveSkillsMessage,
  upsertAgentInstructionsMessage,
} from "../injected-blocks.js";
import {
  planContextMessage,
  upsertPlanContextMessage,
} from "../plan-tool.js";

export interface CompactionCandidateInput {
  readonly messages: readonly ChatMessage[];
  readonly agentInstructionsBlock: string | undefined;
  readonly activeSkillsBlock: string | undefined;
  readonly livePlan: SessionPlan | undefined;
  readonly planApproved: boolean;
}

export const prepareCompactionCandidateMessages = (
  input: CompactionCandidateInput,
): ChatMessage[] => {
  const messages = [...input.messages];
  upsertAgentInstructionsMessage(messages, input.agentInstructionsBlock);
  upsertActiveSkillsMessage(messages, input.activeSkillsBlock);
  if (input.livePlan) {
    upsertPlanContextMessage(
      messages,
      planContextMessage(input.livePlan, input.planApproved),
    );
  }
  return messages;
};
