import { classifyBynaraModel, classifyNvidiaModel } from "./model-families.js";
import { readJson } from "./wire/response-errors.js";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  STREAM_STALL_MARKER,
  THINKING_STREAM_IDLE_TIMEOUT_MS,
  THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS,
  createSseFrameAssembler,
} from "./wire/stream-framing.js";
import {
  ReasoningControlContext,
  ReasoningStyle,
  buildReasoningPayload,
} from "./wire/reasoning-payload.js";
import { chatCompletionsBodyFromPlan } from "./wire/chat-body.js";
import {
  CompatibleReasoningArtifactPolicy,
  OpenAiCompatibleResult,
  compatibleArtifactPolicyFor,
} from "./wire/reasoning-artifacts.js";
export { openAiCompatibleStream } from "./wire/openai-stream.js";
export {
  openAiCompatibleComplete,
  openAiCompatiblePing,
} from "./wire/openai-complete.js";
export {
  catalogEntryVision,
  ingestModelCatalogEntries,
  ingestOpenAiModelCatalog,
} from "./wire/model-catalog.js";
export { toCompletionResult } from "./wire/reasoning-artifacts.js";
export { compatibleArtifactPolicyFor };
export type {
  CompatibleReasoningArtifactPolicy,
  OpenAiCompatibleResult,
} from "./wire/reasoning-artifacts.js";
export {
  buildChatBody,
  isOpenAiReasoningModel,
  toOpenAiMessages,
} from "./wire/chat-body.js";
export { chatCompletionsBodyFromPlan };
export type { ChatCompletionsBodyOptions } from "./wire/chat-body.js";
export {
  imageCapableMessages,
  isImageInputUnsupportedError,
  isReasoningUnsupportedError,
  isStreamOptionsUnsupportedError,
  reasoningRejectionAdvice,
  stripImagesFromMessages,
} from "./wire/capability-errors.js";
export type { ReasoningRejectionAdvice } from "./wire/capability-errors.js";
export { buildReasoningPayload };
export type {
  ReasoningControlContext,
  ReasoningStyle,
} from "./wire/reasoning-payload.js";
export { readStreamLines, streamIdleBudgets } from "./wire/stream-framing.js";
export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  STREAM_STALL_MARKER,
  THINKING_STREAM_IDLE_TIMEOUT_MS,
  THINKING_STREAM_INITIAL_IDLE_TIMEOUT_MS,
  createSseFrameAssembler,
};
export type { StreamLineReaderOptions } from "./wire/stream-framing.js";
export {
  MAX_ERROR_BODY_CHARS,
  MAX_ERROR_BODY_IN_MESSAGE_CHARS,
  bodyAddsInformation,
  collapseWhitespace,
} from "./wire/response-errors.js";
export { readJson };

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number | undefined,
    public readonly body?: string | undefined,
    public readonly retryAfterSeconds?: number | undefined,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export { classifyBynaraModel, classifyNvidiaModel } from "./model-families.js";
export type {
  BynaraReasoningKind,
  NvidiaReasoningKind,
} from "./model-families.js";
