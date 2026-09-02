import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_WEB_1: ToolDefinition[] = [
  def(
    "http.fetch",
    "Raw-by-default HTTP evidence for pentest/protocol/private targets: status, full redirect response headers, final headers/cookies, decoded source body, and captured-body SHA-256. Full output is artifacted while model context is capped separately. Cross-origin redirects strip credentials unless explicitly overridden. Default no status-retries (pass retries to retry 5xx). For https://IP or self-signed lab certs use insecureTls=true (records that verification was off). TLS fingerprint: web.fetch includeTls. Not for casual public-page reading (prefer web.fetch).",
    {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        body: { type: "string" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        maxBytes: {
          type: "integer",
          minimum: 0,
          maximum: 16_777_216,
          description:
            "Maximum decoded response-body bytes captured (default 131072, hard cap 16777216; separate from maxOutputBytes)",
        },
        iOwnThis: { type: "boolean" },
        own: { type: "boolean" },
        retries: {
          type: "integer",
          description:
            "Retry transient 5xx/429 (default 0 for honest evidence)",
        },
        timeoutMs: {
          type: "integer",
          minimum: 1_000,
          maximum: 1_800_000,
          description: "Request timeout in milliseconds (default 40000)",
        },
        responseMode: {
          type: "string",
          enum: ["raw", "readable"],
          description:
            "HTML body formatting: raw response source (default; preserves comments/tags/attributes) or readable text. Prefer web.fetch instead when only page prose is needed.",
        },
        responsePart: {
          type: "string",
          enum: ["full", "headers", "body"],
          description:
            "Return full evidence (default), headers/status only, or body only",
        },
        bottomLines: {
          type: "integer",
          minimum: 0,
          description:
            "Return only the last N rendered lines. Drops everything before them from the model's view; an omission marker is inserted. Evidence stays complete in the saved artifact.",
        },
        maxOutputBytes: {
          type: "integer",
          minimum: 0,
          description:
            "Strict final-output ceiling in bytes. Cuts content the model would otherwise see; a body slice is preserved but the rest is dropped. Model context is capped separately, so this only makes the view smaller.",
        },
        forwardSensitiveHeaders: {
          type: "boolean",
          description:
            "Forward Authorization, Proxy-Authorization, and Cookie across an origin-changing redirect (default false; use only when explicitly intended).",
        },
        insecureTls: {
          type: "boolean",
          description:
            "Skip TLS cert/hostname verification (https://IP, self-signed labs). Authorized testing only; evidence notes verification was disabled.",
        },
        tlsInsecure: {
          type: "boolean",
          description: "Alias of insecureTls",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
];
