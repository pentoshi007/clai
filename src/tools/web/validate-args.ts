import { NormalisedArgs, schemeOf } from "./request-loop.js";
import { isAllowedScheme } from "./ssrf-guard.js";
import { DEFAULT_INCLUDE_HEADERS, DEFAULT_INCLUDE_REDIRECT_CHAIN, DEFAULT_INCLUDE_TIMING, DEFAULT_MAX_BYTES, DEFAULT_REDACT_SENSITIVE, DEFAULT_RESPONSE_MODE, FETCH_TIMEOUT_MS, MAX_FETCH_TIMEOUT_MS, MAX_MAX_BYTES, MIN_FETCH_TIMEOUT_MS, MIN_MAX_BYTES, RESPONSE_MODES } from "./types.js";
import type { ResponseMode, ResponsePart, WebFetchArgs, WebFetchError } from "./types.js";

type ValidationResult =
  | { ok: true; value: NormalisedArgs }
  | { ok: false; error: WebFetchError };

export function validateArgs(args: WebFetchArgs): ValidationResult {
  if (typeof args.url !== "string" || args.url.length === 0) {
    return validationError("url is required and must be a non-empty string");
  }
  if (/\s/.test(args.url)) {
    return validationError(
      "url must not contain whitespace characters (Requirement 7.3)",
    );
  }
  if (/[\u0000-\u001f\u007f]/.test(args.url)) {
    return validationError(
      "url must not contain ASCII control characters (Requirement 7.3)",
    );
  }
  if (!isAllowedScheme(args.url)) {
    return {
      ok: false,
      error: {
        kind: "blocked-scheme",
        message: `Refusing scheme: ${schemeOf(args.url)}`,
        url: args.url,
      },
    };
  }

  let maxBytes = DEFAULT_MAX_BYTES;
  if (args.maxBytes !== undefined) {
    if (
      typeof args.maxBytes !== "number" ||
      !Number.isInteger(args.maxBytes) ||
      args.maxBytes < MIN_MAX_BYTES ||
      args.maxBytes > MAX_MAX_BYTES
    ) {
      return validationError(
        `maxBytes must be an integer in [${MIN_MAX_BYTES}, ${MAX_MAX_BYTES}]`,
      );
    }
    maxBytes = args.maxBytes;
  }

  let timeoutMs = FETCH_TIMEOUT_MS;
  if (args.timeoutMs !== undefined) {
    if (
      typeof args.timeoutMs !== "number" ||
      !Number.isInteger(args.timeoutMs) ||
      args.timeoutMs < MIN_FETCH_TIMEOUT_MS ||
      args.timeoutMs > MAX_FETCH_TIMEOUT_MS
    ) {
      return validationError(
        `timeoutMs must be an integer in [${MIN_FETCH_TIMEOUT_MS}, ${MAX_FETCH_TIMEOUT_MS}]`,
      );
    }
    timeoutMs = args.timeoutMs;
  }

  if (args.includeHeaders !== undefined && typeof args.includeHeaders !== "boolean") {
    return validationError("includeHeaders must be a boolean");
  }
  const includeHeaders =
    args.responsePart === "headers"
      ? true
      : args.includeHeaders ?? DEFAULT_INCLUDE_HEADERS;

  if (args.includeTls !== undefined && typeof args.includeTls !== "boolean") {
    return validationError("includeTls must be a boolean");
  }
  const includeTls = args.includeTls ?? false;

  if (args.includeTiming !== undefined && typeof args.includeTiming !== "boolean") {
    return validationError("includeTiming must be a boolean");
  }
  const includeTiming = args.includeTiming ?? DEFAULT_INCLUDE_TIMING;

  if (
    args.includeRedirectChain !== undefined &&
    typeof args.includeRedirectChain !== "boolean"
  ) {
    return validationError("includeRedirectChain must be a boolean");
  }
  const includeRedirectChain =
    args.includeRedirectChain ?? DEFAULT_INCLUDE_REDIRECT_CHAIN;

  if (args.responseMode !== undefined) {
    if (
      typeof args.responseMode !== "string" ||
      !RESPONSE_MODES.includes(args.responseMode)
    ) {
      return validationError(
        `responseMode must be one of: ${RESPONSE_MODES.join(", ")}`,
      );
    }
  }
  const responseMode: ResponseMode =
    args.responseMode ?? DEFAULT_RESPONSE_MODE;

  let responsePart: ResponsePart = "full";
  if (args.responsePart !== undefined) {
    if (
      args.responsePart !== "full" &&
      args.responsePart !== "headers" &&
      args.responsePart !== "body"
    ) {
      return validationError(
        "responsePart must be one of: full, headers, body",
      );
    }
    responsePart = args.responsePart;
  }

  // redactSensitive: optional boolean (Requirement 2.34).
  if (
    args.redactSensitive !== undefined &&
    typeof args.redactSensitive !== "boolean"
  ) {
    return validationError("redactSensitive must be a boolean");
  }
  const redactSensitive = args.redactSensitive ?? DEFAULT_REDACT_SENSITIVE;

  return {
    ok: true,
    value: {
      url: args.url,
      maxBytes,
      timeoutMs,
      includeHeaders,
      includeTls,
      includeTiming,
      includeRedirectChain,
      responseMode,
      responsePart,
      redactSensitive,
    },
  };
}

function validationError(message: string): ValidationResult {
  return {
    ok: false,
    error: { kind: "validation", message },
  };
}
