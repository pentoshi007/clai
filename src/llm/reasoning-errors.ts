const MISSING_REASONING_CONTENT_RE =
  /reasoning[_ ]?content.*(?:must be )?(?:passed|sent|included|provided)\s*back|missing\s+reasoning[_ ]?content|reasoning[_ ]?content\s+is\s+required/i;

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) return undefined;
  const status = Number((error as { status?: number }).status);
  return Number.isFinite(status) ? status : undefined;
}

function errorHaystack(error: unknown): string {
  const body =
    error && typeof error === "object" && "body" in error
      ? String((error as { body?: string }).body ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return `${message}\n${body}`;
}

export function isMissingReasoningContentError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== undefined && status !== 400 && status !== 422) return false;
  return MISSING_REASONING_CONTENT_RE.test(errorHaystack(error));
}

export function mentionsReasoning(error: unknown): boolean {
  return /chat_template_kwargs|enable_thinking|clear_thinking|reasoning_effort|reasoning_budget|reasoning_content|\breasoning\b|\bthinking\b/i.test(
    errorHaystack(error),
  );
}

export function isUnattributableRequestBodyError(error: unknown): boolean {
  const status = errorStatus(error);
  if (status !== 400 && status !== 422) return false;
  return !mentionsReasoning(error);
}

const IN_BAND_BAD_REQUEST_RE =
  /bad[_ ]?request|invalid[_ ]?request|invalid[_ ]?parameter|parameter is invalid|unsupported[_ ]?parameter|extra inputs are not permitted/i;

export function inBandBadRequestStatus(frame: unknown): number | undefined {
  const text =
    typeof frame === "string"
      ? frame
      : frame && typeof frame === "object"
        ? [
            (frame as { type?: unknown }).type,
            (frame as { code?: unknown }).code,
            (frame as { message?: unknown }).message,
          ]
            .filter((part) => typeof part === "string")
            .join(" ")
        : "";
  return IN_BAND_BAD_REQUEST_RE.test(text) ? 400 : undefined;
}
