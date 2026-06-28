/**
 * `web.fetch` registry handler.
 *
 * Thin adapter that converts a {@link WebFetchArgs} call into a typed
 * {@link WebFetchOutcome} via {@link webFetchCore}, emits exactly one
 * `auditLog("tool.web_fetch", payload)` per invocation (Requirement 5.6),
 * and returns the standard {@link ToolResult} shape consumed by the agent
 * loop and `tool.batch`.
 *
 * Output composition (per the design's "ToolResult mapping" section):
 *
 *   <final URL> <status> <content-type>
 *   mode=<readable|raw>  resolvedIp=<ip>  ...
 *
 *   <metadata block as JSON>
 *
 *   ---
 *   <body>
 *
 * On error outcomes the `output` field begins with the human-readable
 * message defined in the design's error matrix (e.g.
 * "Refusing binary content type: image/png").
 */

import type { ToolResult } from "../../types.js";
import { auditLog } from "../../store/logs.js";
import type { ToolRunOptions } from "../registry.js";
import {
  webFetchCore,
  type WebFetchCoreOptions,
} from "./fetch-core.js";
import { buildFetchAuditPayload } from "./audit.js";
import type { WebFetchArgs, WebFetchOutcome } from "./types.js";

/**
 * Optional injection point for tests so they can stub the underlying
 * transport without monkey-patching `node:http`/`node:https`. Production
 * callers never pass these; the registry handler invokes `webFetch`
 * with no extra options.
 */
export interface WebFetchOptions extends ToolRunOptions {
  core?: WebFetchCoreOptions;
}

/**
 * Run `web.fetch`. Always emits a single audit-log entry; never throws —
 * argument validation, SSRF blocks, network errors, HTTP errors, and
 * timeouts surface as `ok=false` results.
 */
export async function webFetch(
  args: WebFetchArgs,
  options: WebFetchOptions = {},
): Promise<ToolResult> {
  const outcome = await webFetchCore(args, options.core ?? {});

  // Audit every invocation, success or failure (Requirement 5.6).
  // We never await the audit log so a slow disk does not delay the
  // tool result; logging errors are swallowed because they should not
  // cascade into a tool failure.
  void emitAudit(outcome);

  return outcome.ok ? renderSuccess(outcome) : renderError(outcome);
}

async function emitAudit(outcome: WebFetchOutcome): Promise<void> {
  try {
    await auditLog("tool.web_fetch", buildFetchAuditPayload(outcome));
  } catch {
    // Audit-log failures must not surface as tool errors.
  }
}

/**
 * Compose the success-path `output` string. The first line is a one-shot
 * summary so the agent sees the most useful facts before any JSON; the
 * metadata JSON block follows; then `---` separates the body so the
 * agent loop can split if needed.
 */
function renderSuccess(outcome: WebFetchOutcome): ToolResult {
  const meta = outcome.metadata;
  const hasDiagnostics = Boolean(
    meta.headers ||
      meta.tls ||
      meta.timing ||
      meta.redirectChain,
  );
  const summary = `${meta.finalUrl} ${meta.status}${meta.contentType ? ` ${meta.contentType}` : ""}`;
  const second = `mode=${meta.mode}  resolvedIp=${meta.resolvedIp || "?"}  bytes=${meta.bytesReceived}${meta.truncated ? ` (truncated@${meta.truncatedAt ?? meta.bytesReceived})` : ""}`;

  if (!hasDiagnostics && meta.mode === "readable") {
    const output = [
      `URL: ${meta.finalUrl}`,
      `Status: ${meta.status}${meta.contentType ? ` (${meta.contentType})` : ""}`,
      `Bytes: ${meta.bytesReceived}${meta.truncated ? ` (truncated at ${meta.truncatedAt ?? meta.bytesReceived})` : ""}`,
      "",
      "Content:",
      outcome.body,
    ].join("\n");
    return {
      ok: true,
      output,
      exitCode: 0,
      truncated: meta.truncated || false,
      stats: {
        bytesRead: meta.bytesReceived,
        bytesDropped: 0,
        linesRead: outcome.body.split("\n").length,
        elapsedMs: meta.timing?.totalMs ?? 0,
      },
    };
  }

  // Stripped metadata for the JSON block — drop the body-shape fields
  // so the agent reads them once on the first line.
  const jsonBlock = JSON.stringify(
    {
      requestedUrl: meta.requestedUrl,
      finalUrl: meta.finalUrl,
      status: meta.status,
      contentType: meta.contentType,
      resolvedIp: meta.resolvedIp,
      finalHostname: meta.finalHostname,
      mode: meta.mode,
      bytesReceived: meta.bytesReceived,
      truncated: meta.truncated,
      truncatedAt: meta.truncatedAt,
      headers: meta.headers,
      tls: meta.tls,
      timing: meta.timing,
      redirectChain: meta.redirectChain,
      cookies: meta.cookies,
      budget: meta.budget,
    },
    null,
    2,
  );

  const output = `${summary}\n${second}\n\n${jsonBlock}\n\n---\n${outcome.body}`;
  return {
    ok: true,
    output,
    exitCode: 0,
    truncated: meta.truncated || false,
    stats: {
      bytesRead: meta.bytesReceived,
      bytesDropped: 0,
      linesRead: outcome.body.split("\n").length,
      elapsedMs: meta.timing?.totalMs ?? 0,
    },
  };
}

/**
 * Compose the error-path `output` string. The first line is the
 * human-readable error message from the design's error matrix; a JSON
 * envelope of the outcome follows so callers can branch on
 * `error.kind` if needed.
 */
function renderError(outcome: WebFetchOutcome): ToolResult {
  const err = outcome.error;
  const head = err?.message ?? "web.fetch failed";
  const body = JSON.stringify(
    {
      error: err,
      requestedUrl: outcome.metadata.requestedUrl,
      finalUrl: outcome.metadata.finalUrl,
      resolvedIp: outcome.metadata.resolvedIp,
      finalHostname: outcome.metadata.finalHostname,
    },
    null,
    2,
  );
  return {
    ok: false,
    output: `${head}\n\n${body}`,
    exitCode: 1,
  };
}
