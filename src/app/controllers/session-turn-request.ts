import type {
  ChatMessage,
  Mode,
  ProviderId,
  SuccessfulRequestSnapshot,
} from "../../types.js";
import { materializeHistoryImages } from "../../store/history.js";
import { resolveTurnInput } from "../../attachments/service.js";
import { imageBudgetFor } from "../../attachments/image-content.js";
import type { PreviousTurnSignal, RunTurnRequest } from "../ports/agent-port.js";

export interface TurnRequestInput {
  readonly prompt: string;
  readonly mode: Mode;
  readonly provider: ProviderId;
  readonly model: string;
  readonly history: readonly ChatMessage[];
  readonly materializeImages: boolean;
  readonly displayPrompt?: string | null | undefined;
  readonly previousTurn?: PreviousTurnSignal | undefined;
  readonly previousSuccessfulRequest?: SuccessfulRequestSnapshot | undefined;
  readonly contextLimitTokens?: number | undefined;
  readonly getContextLimitTokens?: (
    provider: ProviderId | undefined,
    model: string | undefined,
  ) => number | undefined;
}

export interface BuiltTurnRequest {
  readonly request: RunTurnRequest;
  readonly fallbackReason?: string | undefined;
  readonly imageIssues: readonly string[];
}

/** Resolve attachments/vision once and assemble the agent request. */
export function buildTurnRequest(input: TurnRequestInput): BuiltTurnRequest {
  const resolved = resolveTurnInput({
    prompt: input.prompt,
    mode: input.mode,
    provider: input.provider,
    model: input.model,
  });
  const request: RunTurnRequest = {
    prompt: resolved.prompt,
    mode: resolved.mode,
    provider: resolved.provider,
    model: resolved.model,
    history: input.materializeImages
      ? materializeHistoryImages(
          input.history,
          imageBudgetFor(resolved.provider, resolved.model),
        )
      : input.history,
    attachments: resolved.attachments,
    images: resolved.images,
    visionProven: resolved.capability.support === "yes",
    ...(input.displayPrompt !== undefined
      ? { displayPrompt: input.displayPrompt }
      : {}),
    ...(input.previousTurn ? { previousTurn: input.previousTurn } : {}),
    ...(input.previousSuccessfulRequest
      ? { previousSuccessfulRequest: input.previousSuccessfulRequest }
      : {}),
    ...(input.contextLimitTokens
      ? { contextLimitTokens: input.contextLimitTokens }
      : {}),
    ...(input.getContextLimitTokens
      ? { getContextLimitTokens: input.getContextLimitTokens }
      : {}),
  };
  return {
    request,
    ...(resolved.fallbackReason ? { fallbackReason: resolved.fallbackReason } : {}),
    imageIssues: resolved.imageIssues,
  };
}
