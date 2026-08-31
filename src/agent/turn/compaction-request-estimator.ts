import type { ChatMessage, ProviderId, ToolDefinition } from "../../types.js";
import { accountAssembledRequest } from "../request-accounting.js";

export interface CompactionRequestEstimatorPorts {
  readonly provider: ProviderId;
  readonly model: string;
  readonly selectTools: () => ToolDefinition[] | undefined;
}

const estimate = (
  ports: CompactionRequestEstimatorPorts,
  messages: readonly ChatMessage[],
): number => {
  const tools = ports.selectTools();
  return accountAssembledRequest({
    provider: ports.provider,
    model: ports.model,
    messages,
    stream: true,
    ...(tools?.length ? { tools } : {}),
  }).accounting.requestTokens;
};

export const createCompactionRequestEstimator = (
  ports: CompactionRequestEstimatorPorts,
) =>
  (messages: readonly ChatMessage[]): number => estimate(ports, messages);
