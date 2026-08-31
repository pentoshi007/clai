import type { ChatMessage, ProviderId, ReasoningEffort } from "../../types.js";
import { modelAcceptsImages } from "../capabilities.js";
import { isMissingReasoningContentError } from "../reasoning-errors.js";

/**
 * Detects provider errors that mean the model rejected one of our
 * reasoning/thinking knobs (chat_template_kwargs, enable_thinking,
 * clear_thinking, reasoning_effort, reasoning_budget, thinking). NVIDIA NIM and
 * other OpenAI-compatible gateways return a 400/422 for chat templates that do
 * not accept these fields. When this matches, the router strips the reasoning
 * payload and retries so an unsupported option never fails the whole request.
 */
export function isReasoningUnsupportedError(error: unknown): boolean {
  if (isMissingReasoningContentError(error)) return false;
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();

  const mentionsReasoningKnob =
    // `\breasoning\b` catches bodies like "Unrecognized request argument
    // supplied: reasoning" so a bare reasoning-field rejection also degrades.
    /chat_template_kwargs|enable_thinking|clear_thinking|reasoning_effort|reasoning_budget|reasoning_content|\breasoning\b|\bthinking\b/.test(
      hay,
    );
  if (!mentionsReasoningKnob) return false;

  // A 4xx that names a reasoning field is a parameter rejection — strip it.
  if (status === 400 || status === 422) return true;

  // Any status: explicit "not supported / unknown / invalid parameter" wording.
  return /not support|unsupported|unknown|unrecognized|not a valid|not allowed|unexpected keyword|does not accept|extra fields not permitted|additional propert|invalid[_ ]?(?:request[_ ]?)?(?:argument|parameter|field)/.test(
    hay,
  );
}

export interface ReasoningRejectionAdvice {
  mandatory: boolean;
  acceptedEfforts: readonly ReasoningEffort[];
}

const EFFORT_VOCABULARY: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function reasoningRejectionAdvice(
  error: unknown,
): ReasoningRejectionAdvice | undefined {
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();

  const mandatory =
    /always\s+(?:engages?\s+in|uses?|performs?)\s+(?:thinking|reasoning)|(?:thinking|reasoning)\s+cannot\s+be\s+disabled|cannot\s+be\s+disabled|can(?:no|')t\s+be\s+(?:disabled|turned\s+off)/.test(
      hay,
    );

  const clause =
    /(?:please\s+use|must\s+be\s+one\s+of|must\s+be|one\s+of|supported\s+values?(?:\s+are)?|valid\s+values?(?:\s+are)?|allowed\s+values?(?:\s+are)?|use)\s*:?\s*([^.;\n}"]{0,120})/.exec(
      hay,
    );
  const acceptedEfforts = clause
    ? EFFORT_VOCABULARY.filter((effort) =>
        new RegExp(`\\b${effort}\\b`).test(clause[1] ?? ""),
      )
    : [];

  if (!mandatory && acceptedEfforts.length === 0) return undefined;
  return { mandatory, acceptedEfforts };
}

export function isStreamOptionsUnsupportedError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  if (status !== 400 && status !== 422) return false;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();
  return (
    /stream_options|stream options/.test(hay) &&
    /not support|unsupported|unknown|unrecognized|not a valid|not allowed|unexpected keyword|does not accept|extra fields not permitted|additional propert|invalid[_ ]?(?:request[_ ]?)?(?:argument|parameter|field)/.test(
      hay,
    )
  );
}

export function isImageInputUnsupportedError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? Number((error as { status?: number }).status)
      : undefined;
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  const hay = `${message}\n${body}`.toLowerCase();

  const mentionsImageInput =
    /image_url|image url|inlinedata|inline_data|\bimages?\b|multimodal|\bvision\b|media_type|image content|content\[\d+\]|content\.\d+|parts\[\d+\]/.test(
      hay,
    );
  if (!mentionsImageInput) return false;
  if (
    status !== undefined &&
    status !== 400 &&
    status !== 415 &&
    status !== 422
  ) {
    return false;
  }
  return /not support|unsupported|does not accept|cannot process|invalid[_ ]?(?:request[_ ]?)?(?:argument|parameter|field|type|value)?|unknown|unrecognized|not a valid|not allowed|only text|text[- ]only|expected a string|must be a string|additional propert/.test(
    hay,
  );
}

export function stripImagesFromMessages(
  messages: ChatMessage[],
): ChatMessage[] {
  return messages.map((message) => {
    if (!message.images?.length) return message;
    const { images: _images, ...rest } = message;
    return rest;
  });
}

export function imageCapableMessages(
  provider: ProviderId,
  model: string,
  messages: ChatMessage[],
): ChatMessage[] {
  if (modelAcceptsImages(provider, model)) return messages;
  return stripImagesFromMessages(messages);
}
