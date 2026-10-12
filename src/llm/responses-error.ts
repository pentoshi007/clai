import { MAX_ERROR_BODY_CHARS, ProviderError } from "./http.js";

const ERROR_STATUS: Readonly<Record<string, number>> = {
  server_error: 500,
  internal_server_error: 500,
  server_is_overloaded: 503,
  overloaded_error: 503,
  service_unavailable: 503,
  rate_limit_exceeded: 429,
  slow_down: 429,
  invalid_request_error: 400,
  invalid_encrypted_content: 400,
  authentication_error: 401,
  invalid_api_key: 401,
  permission_denied: 403,
};

function errorRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function responsesError(displayName: string, error: unknown, payload: string): ProviderError {
  const record = errorRecord(error);
  const status = [record.status, record.status_code].find((value): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599)
    ?? [record.code, record.type].flatMap((value) => typeof value === "string" && Object.hasOwn(ERROR_STATUS, value) ? [ERROR_STATUS[value]] : [])[0];
  const rawDetail = typeof error === "string" ? error
    : [record.message, record.code, record.type].find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "unknown error";
  const detail = rawDetail.trim().length <= 2 ? `${rawDetail} — ${payload.slice(0, 300)}` : rawDetail;
  const retryAfter = record.retry_after_seconds ?? record.retry_after;
  const retryAfterSeconds = typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
  return new ProviderError(`${displayName} stream error: ${detail}`, status, payload.slice(0, MAX_ERROR_BODY_CHARS), retryAfterSeconds);
}

export function assertResponsesSuccess(displayName: string, data: unknown): void {
  const record = errorRecord(data);
  if (record.error) throw responsesError(displayName, record.error, JSON.stringify(data));
  if (record.status === "failed") throw responsesError(displayName, { message: "response.failed" }, JSON.stringify(data));
}
