import type { ChatMessage, ProviderId, ToolDefinition } from "../../types.js";
import { accountAssembledRequest } from "../request-accounting.js";

export interface CompactionFinalFitInput {
  readonly provider: ProviderId;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly contextLimitTokens: number | undefined;
  readonly selectTools: () => readonly ToolDefinition[] | undefined;
}

export const measureCompactionFinalFit = (
  input: CompactionFinalFitInput,
): ReturnType<typeof accountAssembledRequest> | undefined => {
  if (input.contextLimitTokens === undefined) return undefined;
  return accountAssembledRequest({
    provider: input.provider,
    model: input.model,
    messages: input.messages,
    stream: true,
    ...(input.selectTools()?.length ? { tools: input.selectTools() } : {}),
    contextLimitTokens: input.contextLimitTokens,
  });
};
