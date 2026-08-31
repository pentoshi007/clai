import { enforce as enforceBudget } from "./budget.js";
import { Capture } from "./capture.js";
import type { CapturedFields } from "./capture.js";
import { applyToCookies, applyToHeaders } from "./redact.js";
import { NormalisedArgs } from "./request-loop.js";
import { DEFAULT_INCLUDE_HEADERS, DEFAULT_INCLUDE_REDIRECT_CHAIN, DEFAULT_INCLUDE_TIMING, DEFAULT_MAX_BYTES, DEFAULT_REDACT_SENSITIVE, FETCH_TIMEOUT_MS, METADATA_BUDGET_BYTES } from "./types.js";
import type { CookieInfo, HeaderMap, RedirectChain, ResponseMode, TimingInfo, WebFetchError, WebFetchMetadata, WebFetchOutcome } from "./types.js";

interface BuildSuccessInput {
  args: NormalisedArgs;
  capture: Capture;
  lastUrl: string;
  body: string;
  bytesReceived: number;
  truncated: boolean;
  truncatedAt?: number;
  contentType: string | undefined;
  now: () => number;
  t0: number;
}

/**
 * Compose a successful {@link WebFetchOutcome} from the captured
 * fields, applying redaction and the 64 KiB metadata budget.
 *
 * Implements the design's "Pipeline steps in detail" §11–12: redact
 * before metadata assembly, then run `budget.enforce` so the final
 * `metadata.budget.metadataBytes` reflects the size of the *trimmed*
 * payload.
 */
export function buildSuccessOutcome(input: BuildSuccessInput): WebFetchOutcome {
  const totalMs = input.now() - input.t0;
  const captured = input.capture.finalize(totalMs);
  return {
    ok: true,
    metadata: assembleMetadata({
      args: input.args,
      captured,
      requestedUrl: input.args.url,
      finalUrl: input.lastUrl,
      status: captured.status,
      contentType: input.contentType,
      bytesReceived: input.bytesReceived,
      truncated: input.truncated,
      ...(input.truncatedAt !== undefined
        ? { truncatedAt: input.truncatedAt }
        : {}),
    }),
    body: input.body,
  };
}

interface ErrorOutcomeInput {
  requestedUrl: string;
  finalUrl: string;
  mode: ResponseMode;
  capture?: Capture | undefined;
  error: WebFetchError;
  now: () => number;
  t0: number;
  includeHeaders?: boolean | undefined;
  includeTls?: boolean | undefined;
  includeTiming?: boolean | undefined;
  includeRedirectChain?: boolean | undefined;
  redactSensitive?: boolean | undefined;
}

/**
 * Compose an `ok=false` {@link WebFetchOutcome}.
 *
 * The metadata envelope is always populated. Pipeline stages that ran
 * before the failure surface their captured values (e.g. `resolvedIp`
 * after a successful DNS lookup but a `blocked-address` IP); stages
 * that did not run carry default zero/empty values. This keeps the
 * audit-log payload built downstream uniform regardless of where the
 * failure surfaced.
 */
export function errorOutcome(input: ErrorOutcomeInput): WebFetchOutcome {
  const totalMs = input.now() - input.t0;
  const captured =
    input.capture !== undefined ? input.capture.finalize(totalMs) : undefined;

  const includeHeaders = input.includeHeaders ?? DEFAULT_INCLUDE_HEADERS;
  const includeTiming = input.includeTiming ?? DEFAULT_INCLUDE_TIMING;
  const includeRedirectChain =
    input.includeRedirectChain ?? DEFAULT_INCLUDE_REDIRECT_CHAIN;
  const includeTls = input.includeTls ?? false;
  const redactSensitive = input.redactSensitive ?? DEFAULT_REDACT_SENSITIVE;

  const args: NormalisedArgs = {
    url: input.requestedUrl,
    maxBytes: DEFAULT_MAX_BYTES,
    timeoutMs: FETCH_TIMEOUT_MS,
    includeHeaders,
    includeTls,
    includeTiming,
    includeRedirectChain,
    responseMode: input.mode,
    responsePart: "full",
    redactSensitive,
  };

  const metadata = captured
    ? assembleMetadata({
        args,
        captured,
        requestedUrl: input.requestedUrl,
        finalUrl: input.finalUrl,
        status: input.error.status ?? captured.status ?? 0,
        contentType: undefined,
        bytesReceived: 0,
        truncated: false,
      })
    : assembleEmptyMetadata({
        args,
        requestedUrl: input.requestedUrl,
        finalUrl: input.finalUrl,
        status: input.error.status ?? 0,
      });

  return {
    ok: false,
    metadata,
    body: "",
    error: input.error,
  };
}

/**
 * Build a {@link WebFetchMetadata} envelope from a {@link CapturedFields}
 * snapshot.
 *
 * Honors the `include*` flags from {@link NormalisedArgs}: setting a
 * flag to `false` strips the corresponding optional field from the
 * envelope (Requirements 2.15–2.18, 2.24). Sensitive headers / cookie
 * values are redacted by `applyToHeaders` / `applyToCookies` before
 * the 64 KiB budget loop runs in {@link enforceBudget}.
 */
function assembleMetadata(input: {
  args: NormalisedArgs;
  captured: CapturedFields;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string | undefined;
  bytesReceived: number;
  truncated: boolean;
  truncatedAt?: number;
}): WebFetchMetadata {
  const { args, captured } = input;

  const headersIn = args.includeHeaders ? captured.headers : undefined;
  const cookiesIn = captured.cookies;
  const redactedHeaders =
    headersIn !== undefined
      ? applyToHeaders(headersIn, args.redactSensitive)
      : undefined;
  const redactedCookies = applyToCookies(cookiesIn, args.redactSensitive);

  const tlsIn = args.includeTls ? captured.tls : undefined;
  const timingIn = args.includeTiming ? captured.timing : undefined;
  const redirectChainIn = args.includeRedirectChain
    ? captured.redirectChain
    : undefined;

  const budgeted = enforceBudget({
    ...(redactedHeaders !== undefined ? { headers: redactedHeaders } : {}),
    ...(tlsIn !== undefined ? { tls: tlsIn } : {}),
    ...(timingIn !== undefined ? { timing: timingIn } : {}),
    ...(redirectChainIn !== undefined ? { redirectChain: redirectChainIn } : {}),
    cookies: redactedCookies,
  });

  const meta: WebFetchMetadata = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    resolvedIp: captured.resolvedIp,
    finalHostname: captured.finalHostname,
    mode: args.responseMode,
    bytesReceived: input.bytesReceived,
    truncated: input.truncated,
    budget: { metadataBytes: budgeted.metadataBytes, cap: METADATA_BUDGET_BYTES },
  };
  if (input.contentType !== undefined) meta.contentType = input.contentType;
  if (input.truncatedAt !== undefined) meta.truncatedAt = input.truncatedAt;
  if (budgeted.headers !== undefined) meta.headers = budgeted.headers;
  if (budgeted.tls !== undefined) meta.tls = budgeted.tls;
  if (budgeted.timing !== undefined) meta.timing = budgeted.timing;
  if (budgeted.redirectChain !== undefined)
    meta.redirectChain = budgeted.redirectChain;
  if (budgeted.cookies !== undefined) meta.cookies = budgeted.cookies;
  return meta;
}

/**
 * Build a minimal {@link WebFetchMetadata} envelope for failures that
 * surfaced before any transport-level capture happened (argument
 * validation, blocked scheme on the entry URL, etc.).
 */
function assembleEmptyMetadata(input: {
  args: NormalisedArgs;
  requestedUrl: string;
  finalUrl: string;
  status: number;
}): WebFetchMetadata {
  const emptyTiming: TimingInfo = { dnsMs: 0, tcpMs: 0, ttfbMs: 0, totalMs: 0 };
  const budgeted = enforceBudget({
    ...(input.args.includeHeaders ? { headers: {} as HeaderMap } : {}),
    ...(input.args.includeTiming ? { timing: emptyTiming } : {}),
    ...(input.args.includeRedirectChain
      ? { redirectChain: [] as RedirectChain }
      : {}),
    cookies: [] as CookieInfo[],
  });

  const meta: WebFetchMetadata = {
    requestedUrl: input.requestedUrl,
    finalUrl: input.finalUrl,
    status: input.status,
    resolvedIp: "",
    finalHostname: tryHostname(input.finalUrl),
    mode: input.args.responseMode,
    bytesReceived: 0,
    truncated: false,
    budget: { metadataBytes: budgeted.metadataBytes, cap: METADATA_BUDGET_BYTES },
  };
  if (budgeted.headers !== undefined) meta.headers = budgeted.headers;
  if (budgeted.timing !== undefined) meta.timing = budgeted.timing;
  if (budgeted.redirectChain !== undefined)
    meta.redirectChain = budgeted.redirectChain;
  if (budgeted.cookies !== undefined) meta.cookies = budgeted.cookies;
  return meta;
}

/** Best-effort hostname extraction; returns "" for malformed URLs. */
function tryHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
