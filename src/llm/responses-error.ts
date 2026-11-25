import { MAX_ERROR_BODY_CHARS, ProviderError } from "./http.js";
import { parseRetryAfterHeader, parseRetryHintFromBody } from "./wire/response-errors.js";

const ERROR_STATUS: Readonly<Record<string, number>> = {
  server_error: 500,
  internal_server_error: 500,
  server_is_overloaded: 503,
  policy_capacity_unavailable: 503,
  overloaded_error: 503,
  service_unavailable: 503,
  rate_limit_exceeded: 429,
  slow_down: 429,
  invalid_request_error: 400,
  invalid_encrypted_content: 400,
  context_length_exceeded: 400,
  authentication_error: 401,
  invalid_api_key: 401,
  invalid_api_key_error: 403,
  insufficient_quota_error: 402,
  insufficient_quota: 402,
  credit_balance_exhausted: 402,
  not_found_error: 404,
  rate_limit_exceeded_error: 429,
  model_rate_limit_exceeded_error: 429,
  model_call_failed: 502,
  model_overloaded: 503,
  permission_denied: 403,
};

const API_SPEND_LIMIT_SCOPES = new Map([
  ["api_key_spend_limit_exceeded", "API key"],
  ["project_spend_limit_exceeded", "Project"],
  ["organization_spend_limit_exceeded", "Organization"],
]);

function errorRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function retryAfterFromHeaders(raw: unknown): number | undefined {
  const header = Object.entries(errorRecord(raw)).find(([name]) => name.toLowerCase() === "retry-after");
  const value = Array.isArray(header?.[1]) ? header[1][0] : header?.[1];
  return parseRetryAfterHeader(typeof value === "string" ? value : null);
}

function spendLimitScope(error: Record<string, unknown>): string | undefined {
  return typeof error.code === "string" ? API_SPEND_LIMIT_SCOPES.get(error.code) : undefined;
}

export function responsesHttpError(error: ProviderError, displayName: string, model: string): ProviderError {
  let scope: string | undefined;
  if (error.status === 429 && error.retryable !== false && error.body) {
    try {
      const payload = errorRecord(JSON.parse(error.body));
      scope = spendLimitScope(errorRecord(payload.error));
    } catch {}
  }
  const detail = scope ? `${scope} spend limit exceeded. ${error.message}` : error.message;
  return new ProviderError(
    `${displayName} (model=${model}): ${detail}`,
    error.status,
    error.body,
    error.retryAfterSeconds,
    scope ? false : error.retryable,
  );
}

export function responsesError(displayName: string, error: unknown, payload: string, headers?: unknown): ProviderError {
  const record = errorRecord(error);
  const spendScope = spendLimitScope(record);
  const explicitStatus = [record.status, record.status_code].find((value): value is number =>
    typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599);
  const mappedCode = [record.code, record.type].find((value): value is string =>
    typeof value === "string" && Object.hasOwn(ERROR_STATUS, value));
  const status = explicitStatus ?? (spendScope ? 429 : undefined) ?? ERROR_STATUS[mappedCode ?? ""];
  const rawDetail = typeof error === "string" ? error
    : [record.message, record.code, record.type].find((value): value is string => typeof value === "string" && value.trim().length > 0) ?? "unknown error";
  const detail = rawDetail.trim().length <= 2 ? `${rawDetail} — ${payload.slice(0, 300)}` : rawDetail;
  const retryAfter = record.retry_after_seconds ?? record.retry_after;
  const retryAfterSeconds = retryAfterFromHeaders(record.headers)
    ?? retryAfterFromHeaders(headers)
    ?? (typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined)
    ?? (status === 429 && !spendScope ? parseRetryHintFromBody(rawDetail) : undefined);
  const message = spendScope ? `${spendScope} spend limit exceeded. ${detail}` : detail;
  return new ProviderError(
    `${displayName} stream error: ${message}`,
    status,
    payload.slice(0, MAX_ERROR_BODY_CHARS),
    retryAfterSeconds,
    spendScope ? false : undefined,
  );
}

export function assertResponsesSuccess(displayName: string, data: unknown): void {
  const record = errorRecord(data);
  if (record.error) throw responsesError(displayName, record.error, JSON.stringify(data), record.headers);
  if (record.status === "failed") throw responsesError(displayName, { message: "response.failed" }, JSON.stringify(data));
}
