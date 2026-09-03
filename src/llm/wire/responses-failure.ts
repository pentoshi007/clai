import { ProviderError } from "../http.js";

export type ExtrasLevel = "full" | "bare";

export type FailureVerdict = "unsupported-endpoint" | "unsupported-extras" | "other";

const ENDPOINT_UNSUPPORTED_STATUS = new Set([404, 405, 501]);

export const PROBE_UNRELIABLE_STATUS = new Set([500, 502, 503, 504]);

const EXTRA_FIELD_PATTERN =
  /prompt_cache_key|encrypted_content|\binclude\b|\bstore\b|\breasoning\b|reasoning_effort/i;

const PARAMETER_REJECTION_PATTERN =
  /unknown (?:parameter|field|argument)|unrecognized (?:parameter|field|request)|not supported|unsupported|invalid parameter|unexpected (?:parameter|field)|does not accept|not a valid (?:parameter|field)|must be one of|expected one of/i;

const ENDPOINT_REJECTION_PATTERN =
  /not found|unknown (?:path|url|endpoint)|no route|does not exist|invalid url|unrecognized request url|unsupported (?:endpoint|path|api)|no such endpoint/i;

const GENERIC_REJECTION_PATTERN = /bad_request|response\.failed|the model rejected/i;

const REASONING_FIELD_PATTERN =
  /reasoning|thinking|effort|enable_thinking|chat_template|include|store|prompt_cache/i;

export function failureText(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const body = error instanceof ProviderError ? (error.body ?? "") : "";
  return `${error.message}\n${body}`;
}

export function providerStatusCode(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status > 0 ? status : undefined;
}

export function isGenericModelRejection(
  status: number | undefined,
  text: string,
): boolean {
  if (status !== undefined && status !== 400 && status !== 422) return false;
  if (!GENERIC_REJECTION_PATTERN.test(text)) return false;
  return !REASONING_FIELD_PATTERN.test(text);
}

export function classifyResponsesFailure(
  error: unknown,
  extras: ExtrasLevel,
): FailureVerdict {
  const status =
    error instanceof ProviderError && error.status !== undefined
      ? error.status
      : undefined;
  if (status !== undefined && ENDPOINT_UNSUPPORTED_STATUS.has(status)) {
    return "unsupported-endpoint";
  }
  if (status !== undefined && status !== 400 && status !== 422) {
    return "other";
  }
  const text = failureText(error);
  if (status === undefined && text.trim() === "") return "other";
  if (
    extras === "full" &&
    EXTRA_FIELD_PATTERN.test(text) &&
    PARAMETER_REJECTION_PATTERN.test(text)
  ) {
    return "unsupported-extras";
  }
  if (ENDPOINT_REJECTION_PATTERN.test(text)) {
    return "unsupported-endpoint";
  }
  return "other";
}
