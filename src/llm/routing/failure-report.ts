import type { ProviderId } from "../../types.js";
import {
  bodyAddsInformation,
  collapseWhitespace,
  MAX_ERROR_BODY_IN_MESSAGE_CHARS,
  ProviderError,
  STREAM_STALL_MARKER,
} from "../http.js";
import { markStreamEmittedBytes } from "../stream-progress.js";
import {
  mentionsQuotaExhaustion,
  mentionsRateLimit,
} from "../quota-signals.js";
import {
  isCacheOnlyColdError,
  markServerErrorAttempts,
  serverErrorAttemptsFor,
} from "./error-classification.js";

function appendFullProviderBody(text: string, error: unknown): string {
  if (!(error instanceof ProviderError)) return text;
  const body = (error.body ?? "").trim();
  if (!body || !bodyAddsInformation(body, text)) return text;
  const shown = collapseWhitespace(body);
  const capped =
    shown.length > MAX_ERROR_BODY_IN_MESSAGE_CHARS
      ? `${shown.slice(0, MAX_ERROR_BODY_IN_MESSAGE_CHARS)}…`
      : shown;
  return `${text}\nFull response from provider: ${capped}`;
}

export function formatProviderFailureForUser(error: unknown): string {
  if (error instanceof ProviderError) {
    const exactError = error.message.replace(/\s+/g, " ").trim();
    const withExactError = (guidance: string): string =>
      exactError
        ? `${guidance}\nExact provider error: ${exactError}`
        : guidance;
    const withFullBody = (text: string): string =>
      appendFullProviderBody(text, error);
    const status = error.status ?? 0;
    if (status === 429) {
      return withFullBody(
        withExactError(
          "Model is rate limited (429). Try another provider/model or switch to a paid plan.",
        ),
      );
    }
    if (status === 401 || status === 403) {
      return withFullBody(
        withExactError(
          `Authentication/authorization failed (${status}). Check the API key with \`clai providers\` or set the provider env var.`,
        ),
      );
    }
    if (status === 402) {
      return withFullBody(
        withExactError(
          "Insufficient credits / payment required (402). Try another API key for this provider, top up the account, or switch provider.",
        ),
      );
    }
    if (status === 404) {
      return withFullBody(
        withExactError(
          "Model or endpoint not found (404). Run `/model list` or pick another model.",
        ),
      );
    }
    if (status === 413) {
      return withFullBody(
        withExactError(
          "Request exceeded the provider input limit (413). Wait for auto-compact, run `/compact`, or continue with a smaller turn.",
        ),
      );
    }
    if (status === 422) {
      return withFullBody(
        withExactError(
          "Provider rejected the request body (422). Model name or parameters may be incompatible — try another model.",
        ),
      );
    }
    if (status === 503 || status === 502 || status === 504) {
      if (isCacheOnlyColdError(error)) {
        return withFullBody(
          withExactError(
            `Gateway cache admission rejected (${status}; cache_only_cold): the route is cold or overloaded and retried automatically with backoff. If it persists, retry shortly or switch provider/model.`,
          ),
        );
      }
      return withFullBody(
        withExactError(
          `Upstream provider unavailable (${status}). Retry shortly or switch provider/model; free-tier models are often capacity-constrained.`,
        ),
      );
    }
    if (status >= 500 && status < 600) {
      return withFullBody(
        withExactError(
          `Upstream provider error (${status}). Retry or switch with \`/provider\` / \`/model\`.`,
        ),
      );
    }
    if (mentionsQuotaExhaustion(error)) {
      return withFullBody(
        withExactError(
          "Provider reports the quota/credits for this key are exhausted. Add another API key (clai set <provider> <key>), top up the account, or switch provider.",
        ),
      );
    }
    if (mentionsRateLimit(error)) {
      return withFullBody(
        withExactError(
          "Model is rate limited (reported in the provider error body, without a 429 status). Try another API key, provider, or model.",
        ),
      );
    }
  }
  const message = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim();
  const generic = ((): string => {
    if (!message) {
      return "Provider returned an empty failure (no tokens billed). Model may be unavailable, overloaded, or rejected before admission — try another model.";
    }
    if (
      /socket connection was closed|econnreset|premature close|unexpected end of file/i.test(
        message,
      )
    ) {
      return `${message} — connection dropped mid-request (common on free/unstable routes). Retry or switch model; long contexts increase disconnect risk.`;
    }
    if (new RegExp(STREAM_STALL_MARKER, "i").test(message)) {
      return `${message}`;
    }
    if (/stream stalled|request timed out before any response/i.test(message)) {
      return `${message} — no tokens arrived in time. Free models and large contexts fail more often; retry or use a more reliable model.`;
    }
    if (
      /no completion text|response was empty|empty response|returned no text/i.test(
        message,
      )
    ) {
      return `${message} — provider accepted the request but returned no content. Retry once; if it persists, switch model.`;
    }
    if (
      /fetch failed|network error|etimedout|enotfound|econnrefused/i.test(
        message,
      )
    ) {
      return `${message} — network/DNS failure reaching the provider. Check connectivity and provider base URL.`;
    }
    if (mentionsQuotaExhaustion(error)) {
      return `${message} — the provider reports quota/credits exhausted for this key. Add another API key or switch provider.`;
    }
    if (mentionsRateLimit(error)) {
      return `${message} — the provider reports rate limiting without a 429 status. Retry shortly, or switch API key/provider.`;
    }
    return message;
  })();
  return appendFullProviderBody(generic, error);
}

function summarizeProviderError(error: unknown): string {
  return formatProviderFailureForUser(error);
}

const FREE_PROVIDER_HINT =
  "the free tier (opencode zen / kilo gateway) is keyless and best-effort, so it is often rate limited or unavailable — set an API key for another provider (clai set <provider> <key>, then clai use <provider>) for reliable access";

export function failureMessageFor(
  providerId: ProviderId,
  error: unknown,
): string {
  const base = summarizeProviderError(error);
  return providerId === "free" ? `${base} — ${FREE_PROVIDER_HINT}` : base;
}

export interface ProviderFailure {
  provider: ProviderId;
  message: string;
  error?: unknown;
}

export class AggregateProviderError extends ProviderError {
  constructor(
    message: string,
    readonly failures: ReadonlyArray<{ provider: ProviderId; message: string }>,
    status?: number | undefined,
    retryAfterSeconds?: number | undefined,
  ) {
    super(message, status, undefined, retryAfterSeconds);
    this.name = "AggregateProviderError";
  }
}

function mostActionableFailure(
  failures: ProviderFailure[],
): ProviderError | undefined {
  const candidates = failures
    .map((failure) => failure.error)
    .filter(
      (error): error is ProviderError =>
        error instanceof ProviderError && typeof error.status === "number",
    );
  if (candidates.length === 0) return undefined;
  const rank = (status: number): number =>
    status === 413 ? 0 : status === 429 ? 1 : status >= 500 ? 2 : 3;
  return candidates.reduce((best, current) =>
    rank(current.status!) < rank(best.status!) ? current : best,
  );
}

export function aggregateProviderError(
  message: string,
  failures: ProviderFailure[],
  emittedBytes = 0,
): AggregateProviderError {
  const actionable = mostActionableFailure(failures);
  const aggregate = new AggregateProviderError(
    message,
    failures.map(({ provider, message: text }) => ({
      provider,
      message: text,
    })),
    actionable?.status,
    actionable?.retryAfterSeconds,
  );
  markStreamEmittedBytes(aggregate, emittedBytes);
  const serverAttempts = failures.reduce(
    (total, failure) => Math.max(total, serverErrorAttemptsFor(failure.error)),
    0,
  );
  return markServerErrorAttempts(aggregate, serverAttempts);
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

export function formatFailures(failures: ProviderFailure[]): string {
  if (failures.length === 0) return "";
  return ` — ${failures
    .map(
      (failure) => `${failure.provider}: ${escapeTableCell(failure.message)}`,
    )
    .join("; ")}`;
}

export function shouldStopProviderFallback(error: unknown): boolean {
  if (error instanceof ProviderError) {
    return [401, 403, 404, 422, 429].includes(error.status ?? 0);
  }
  const message = error instanceof Error ? error.message : String(error);
  return /no completion text|response was empty|empty response|returned no text/i.test(
    message,
  );
}
