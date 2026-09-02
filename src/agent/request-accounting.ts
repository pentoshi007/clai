import type {
  ChatImage,
  ChatMessage,
  ProviderId,
  ReasoningPreference,
  ToolChoice,
  ToolDefinition,
} from "../types.js";
import {
  compileRequestPlan,
  type RequestPlanV1,
} from "../llm/request-plan.js";
import { reasoningArtifactTokensForMessage } from "../llm/reasoning-artifacts.js";
import {
  calibratedRequestTokens,
  requestTokenCalibration,
} from "../llm/token-estimate-calibration.js";
import { nominalModelContextWindow } from "../llm/context-windows.js";
import { readImageDimensions } from "../attachments/image-content.js";
import { measureToolCallsChars } from "./message-slim.js";


export const RESERVED_OUTPUT_TOKENS = 24_576;
export const SAFETY_MARGIN_TOKENS = 2_048;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 3.3);
}

const MIN_IMAGE_TOKENS = 300;
const MAX_IMAGE_TOKENS = 6_000;

export function estimateImageTokens(image: ChatImage): number {
  const rawBytes = Math.ceil((image.dataBase64.length * 3) / 4);
  if (rawBytes <= 0) return MIN_IMAGE_TOKENS;
  const dimensions = readImageDimensions(
    Buffer.from(image.dataBase64.slice(0, 8192), "base64"),
  );
  const tokens = dimensions
    ? Math.ceil((dimensions.width * dimensions.height) / 750)
    : Math.ceil(rawBytes / 900);
  return Math.min(MAX_IMAGE_TOKENS, Math.max(MIN_IMAGE_TOKENS, tokens));
}

export function estimateMessageTokens(message: ChatMessage): number {
  let sum = estimateTextTokens(message.content) + 4;
  if (message.toolCalls?.length) {
    const toolChars = measureToolCallsChars(message.toolCalls);
    sum += Math.ceil(toolChars / 3.3);
  }
  sum += reasoningArtifactTokensForMessage(message);
  if (message.images) {
    for (const image of message.images) {
      sum += estimateImageTokens(image);
    }
  }
  return sum;
}

export function estimateMessagesTokens(
  messages: readonly ChatMessage[],
): number {
  let sum = 0;
  for (const message of messages) {
    sum += estimateMessageTokens(message);
  }
  return sum;
}

export function estimateToolSchemaTokens(
  tools: readonly ToolDefinition[] | undefined,
): number {
  if (!tools?.length) return 0;
  return estimateTextTokens(JSON.stringify(tools));
}

export type EffectiveLimitSource =
  | "session-override"
  | "model-window"
  | "unknown";

export interface EffectiveContextLimit {
  readonly limitTokens?: number | undefined;
  readonly source: EffectiveLimitSource;
  readonly reservedOutputTokens: number;
  readonly safetyMarginTokens: number;
  readonly effectiveSafeTokens?: number | undefined;
}

export function resolveEffectiveContextLimit(input?: {
  readonly provider?: ProviderId | undefined;
  readonly model?: string | undefined;
  readonly contextLimitTokens?: number | undefined;
  readonly reservedOutputTokens?: number | undefined;
  readonly safetyMarginTokens?: number | undefined;
}): EffectiveContextLimit {
  const safetyMarginTokens =
    input?.safetyMarginTokens ?? SAFETY_MARGIN_TOKENS;
  const custom = input?.contextLimitTokens;
  const override =
    typeof custom === "number" && Number.isFinite(custom) && custom > 0
      ? Math.floor(custom)
      : undefined;
  const limitTokens =
    override ??
    (input?.model !== undefined || input?.provider !== undefined
      ? nominalModelContextWindow(input.model)
      : undefined);
  if (limitTokens === undefined) {
    return {
      source: "unknown",
      reservedOutputTokens: input?.reservedOutputTokens ?? RESERVED_OUTPUT_TOKENS,
      safetyMarginTokens,
    };
  }
  const reservedOutputTokens =
    input?.reservedOutputTokens ??
    Math.min(RESERVED_OUTPUT_TOKENS, Math.floor(limitTokens * 0.25));
  return {
    limitTokens,
    source: override !== undefined ? "session-override" : "model-window",
    reservedOutputTokens,
    safetyMarginTokens,
    effectiveSafeTokens: Math.max(
      1,
      limitTokens - reservedOutputTokens - safetyMarginTokens,
    ),
  };
}

export interface RequestAccounting {
  readonly requestTokens: number;
  readonly rawRequestTokens: number;
  readonly instructionsTokens: number;
  readonly historyTokens: number;
  readonly liveTokens: number;
  readonly toolsTokens: number;
  readonly artifactTokens: number;
  readonly replayedArtifactCount: number;
  readonly imageTokens: number;
  readonly imageCount: number;
  readonly messageCount: number;
  readonly limit: EffectiveContextLimit;
  readonly headroomTokens?: number | undefined;
  readonly overLimit?: boolean | undefined;
  readonly precision: "estimate" | "calibrated";
}

function accountTimeline(plan: RequestPlanV1): {
  instructionsTokens: number;
  historyTokens: number;
  liveTokens: number;
} {
  const totals = { instructionsTokens: 0, historyTokens: 0, liveTokens: 0 };
  const messages = plan.timeline.messages;
  for (const section of plan.timeline.sections) {
    let sectionTokens = 0;
    for (let index = section.messageStart; index < section.messageEnd; index += 1) {
      sectionTokens += estimateMessageTokens(messages[index]!);
    }
    if (section.kind === "instructions") totals.instructionsTokens = sectionTokens;
    else if (section.kind === "history") totals.historyTokens = sectionTokens;
    else totals.liveTokens = sectionTokens;
  }
  return totals;
}

export function accountRequestPlan(
  plan: RequestPlanV1,
  policy?: {
    readonly provider?: ProviderId | undefined;
    readonly model?: string | undefined;
    readonly contextLimitTokens?: number | undefined;
    readonly reservedOutputTokens?: number | undefined;
    readonly safetyMarginTokens?: number | undefined;
  },
): RequestAccounting {
  const totals = accountTimeline(plan);
  const toolsTokens = estimateToolSchemaTokens(plan.tools.definitions);
  const rawRequestTokens =
    totals.instructionsTokens +
    totals.historyTokens +
    totals.liveTokens +
    toolsTokens;
  const route = {
    provider: policy?.provider ?? plan.route.provider,
    model: policy?.model ?? plan.route.model,
  };
  const calibration = requestTokenCalibration(route.provider, route.model);
  const requestTokens = calibratedRequestTokens(
    route.provider,
    route.model,
    rawRequestTokens,
  );
  const artifactTokens = plan.timeline.messages.reduce(
    (sum, message) => sum + reasoningArtifactTokensForMessage(message),
    0,
  );
  const imageTokens = plan.timeline.messages.reduce(
    (sum, message) =>
      sum +
      (message.images ?? []).reduce(
        (inner, image) => inner + estimateImageTokens(image),
        0,
      ),
    0,
  );
  const limit = resolveEffectiveContextLimit({
    provider: route.provider,
    model: route.model,
    ...(policy?.contextLimitTokens !== undefined
      ? { contextLimitTokens: policy.contextLimitTokens }
      : {}),
    ...(policy?.reservedOutputTokens !== undefined
      ? { reservedOutputTokens: policy.reservedOutputTokens }
      : {}),
    ...(policy?.safetyMarginTokens !== undefined
      ? { safetyMarginTokens: policy.safetyMarginTokens }
      : {}),
  });
  const effectiveSafeTokens = limit.effectiveSafeTokens;
  return {
    requestTokens,
    rawRequestTokens,
    instructionsTokens: totals.instructionsTokens,
    historyTokens: totals.historyTokens,
    liveTokens: totals.liveTokens,
    toolsTokens,
    artifactTokens,
    replayedArtifactCount: plan.cache.fingerprint.replayedArtifactCount,
    imageTokens,
    imageCount: plan.images.imageCount,
    messageCount: plan.timeline.messages.length,
    limit,
    ...(effectiveSafeTokens !== undefined
      ? {
          headroomTokens: effectiveSafeTokens - requestTokens,
          overLimit: requestTokens > effectiveSafeTokens,
        }
      : {}),
    precision: calibration ? ("calibrated" as const) : ("estimate" as const),
  };
}

export function accountAssembledRequest(input: {
  readonly provider: ProviderId;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly tools?: readonly ToolDefinition[] | undefined;
  readonly toolChoice?: ToolChoice | undefined;
  readonly parallelToolCalls?: boolean | undefined;
  readonly reasoning?: ReasoningPreference | undefined;
  readonly contextLimitTokens?: number | undefined;
  readonly reservedOutputTokens?: number | undefined;
  readonly safetyMarginTokens?: number | undefined;
}): { plan: RequestPlanV1; accounting: RequestAccounting } {
  const plan = compileRequestPlan({
    provider: input.provider,
    model: input.model,
    messages: input.messages,
    stream: input.stream,
    reasoning: input.reasoning,
    tools: input.tools,
    toolChoice: input.toolChoice,
    parallelToolCalls: input.parallelToolCalls,
    ...(input.contextLimitTokens !== undefined
      ? { contextLimitTokens: input.contextLimitTokens }
      : {}),
  });
  return {
    plan,
    accounting: accountRequestPlan(plan, {
      provider: input.provider,
      model: input.model,
      ...(input.contextLimitTokens !== undefined
        ? { contextLimitTokens: input.contextLimitTokens }
        : {}),
      ...(input.reservedOutputTokens !== undefined
        ? { reservedOutputTokens: input.reservedOutputTokens }
        : {}),
      ...(input.safetyMarginTokens !== undefined
        ? { safetyMarginTokens: input.safetyMarginTokens }
        : {}),
    }),
  };
}

export class RequestOverLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestOverLimitError";
  }
}
