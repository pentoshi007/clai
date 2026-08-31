import type {
  NativeToolCall,
  ProviderId,
  ReasoningArtifact,
  ReasoningBlock,
  TokenUsage,
} from "../../types.js";
import type { FinalTurnPreservation } from "../provider-profile.js";
import {
  createReasoningArtifact,
  createReasoningArtifactProvenance,
  reasoningArtifactsObserved,
  visibleReasoningDetailText,
} from "../reasoning-artifacts.js";
import { withReasoningObservation } from "../token-usage.js";

/** Controls how a compatible route's captured plaintext/details can persist. */
export interface CompatibleReasoningArtifactPolicy {
  readonly scope: ReasoningArtifact["replay"]["scope"];
  readonly persistence: ReasoningArtifact["replay"]["persistence"];
}

const DEFAULT_COMPATIBLE_REASONING_ARTIFACT_POLICY: CompatibleReasoningArtifactPolicy =
  {
    scope: "all-history",
    persistence: "tool-turn",
  };

const PRESERVED_FINAL_TURN_ARTIFACT_POLICY: CompatibleReasoningArtifactPolicy =
  {
    scope: "all-history",
    persistence: "all-turns",
  };

export function compatibleArtifactPolicyFor(
  preservation: FinalTurnPreservation,
): CompatibleReasoningArtifactPolicy {
  return preservation === "required"
    ? PRESERVED_FINAL_TURN_ARTIFACT_POLICY
    : DEFAULT_COMPATIBLE_REASONING_ARTIFACT_POLICY;
}

export interface OpenAiCompatibleResult {
  text: string;
  toolCalls?: NativeToolCall[] | undefined;
  finishReason?: string | undefined;
  usage?: TokenUsage | undefined;
  reasoningBlock?: ReasoningBlock | undefined;
  reasoningArtifacts?: readonly ReasoningArtifact[] | undefined;
}

export function artifactRaw(
  value: unknown,
): ReasoningArtifact["raw"] | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    return value as Readonly<Record<string, unknown>>;
  }
  return undefined;
}

export function openAiReasoningText(
  channel:
    | {
        reasoning_content?: string | undefined;
        reasoning?: string | undefined;
        thinking?: unknown;
      }
    | undefined,
): string | undefined {
  const primary = channel?.reasoning_content ?? channel?.reasoning;
  if (typeof primary === "string" && primary) return primary;
  const thinking = channel?.thinking;
  return typeof thinking === "string" && thinking ? thinking : undefined;
}

export function compatibleReasoningArtifacts(input: {
  providerId: ProviderId;
  model: string;
  baseUrl: string;
  toolCalls: readonly NativeToolCall[];
  policy?: CompatibleReasoningArtifactPolicy | undefined;
  reasoning?: { text: string; sequence: number } | undefined;
  details?:
    readonly { raw: ReasoningArtifact["raw"]; sequence: number }[] | undefined;
  thoughtSignatures?:
    | readonly {
        raw: string;
        sequence: number;
        toolCallIndex?: number | undefined;
      }[]
    | undefined;
}): readonly ReasoningArtifact[] | undefined {
  const policy = input.policy ?? DEFAULT_COMPATIBLE_REASONING_ARTIFACT_POLICY;
  const provenance = createReasoningArtifactProvenance({
    provider: input.providerId,
    model: input.model,
    dialect: "openai-compatible",
    endpoint: input.baseUrl,
  });
  const artifacts: ReasoningArtifact[] = [];
  const primaryToolPosition = input.toolCalls.length > 0 ? 0 : undefined;
  if (input.reasoning?.text) {
    artifacts.push(
      createReasoningArtifact({
        kind: "plaintext",
        raw: input.reasoning.text,
        displaySummary: input.reasoning.text,
        provenance,
        replay: policy,
        position: {
          sequence: input.reasoning.sequence,
          placement:
            primaryToolPosition === undefined
              ? "assistant"
              : "before-tool-call",
          ...(primaryToolPosition === undefined
            ? {}
            : { toolCallIndex: primaryToolPosition }),
        },
      }),
    );
  }
  for (const detail of input.details ?? []) {
    const visible = visibleReasoningDetailText(detail.raw);
    artifacts.push(
      createReasoningArtifact({
        kind: "structured-details",
        raw: detail.raw,
        ...(visible ? { displaySummary: visible } : {}),
        provenance,
        replay: policy,
        position: {
          sequence: detail.sequence,
          placement:
            primaryToolPosition === undefined
              ? "assistant"
              : "before-tool-call",
          ...(primaryToolPosition === undefined
            ? {}
            : { toolCallIndex: primaryToolPosition }),
        },
      }),
    );
  }
  for (const signature of input.thoughtSignatures ?? []) {
    const toolCallIndex = signature.toolCallIndex;
    artifacts.push(
      createReasoningArtifact({
        kind: "thought-signature",
        raw: signature.raw,
        provenance,
        replay:
          toolCallIndex === undefined
            ? { scope: "none", persistence: "never" }
            : { scope: "tool-turn", persistence: "tool-turn" },
        position: {
          sequence: signature.sequence,
          placement: toolCallIndex === undefined ? "assistant" : "on-tool-call",
          ...(toolCallIndex === undefined ? {} : { toolCallIndex }),
        },
      }),
    );
  }
  return artifacts.length ? artifacts : undefined;
}

export function toCompletionResult(
  provider: ProviderId,
  model: string,
  payload: OpenAiCompatibleResult,
): import("../../types.js").CompletionResult {
  const usage = withReasoningObservation(
    payload.usage,
    Boolean(payload.reasoningBlock?.text.trim()) ||
      reasoningArtifactsObserved(payload.reasoningArtifacts),
  );
  return {
    text: payload.text,
    provider,
    model,
    ...(payload.toolCalls?.length ? { toolCalls: payload.toolCalls } : {}),
    ...(payload.finishReason ? { finishReason: payload.finishReason } : {}),
    ...(usage ? { usage } : {}),
    ...(payload.reasoningBlock
      ? { reasoningBlock: payload.reasoningBlock }
      : {}),
    ...(payload.reasoningArtifacts
      ? { reasoningArtifacts: payload.reasoningArtifacts }
      : {}),
  };
}

function sentReasoningEffort(requestBody: string): string | undefined {
  try {
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    if (typeof body.reasoning_effort === "string" && body.reasoning_effort) {
      return body.reasoning_effort;
    }
    const nested = body.reasoning;
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const effort = (nested as Record<string, unknown>).effort;
      if (typeof effort === "string" && effort) return effort;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function privateReasoningNote(
  provider: string,
  requestBody: string,
  reasoningTokens: number,
): string {
  const effort = sentReasoningEffort(requestBody);
  const effortText = effort ? ` at ${effort} effort` : "";
  return `Reasoning is private on ${provider}: the model reasoned${effortText} and used ${reasoningTokens.toLocaleString("en-US")} reasoning tokens, but the API returns no reasoning text to display.`;
}
