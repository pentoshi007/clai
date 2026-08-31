
import type { ToolResult } from "../../types.js";
import { auditLog } from "../../store/logs.js";
import type { ToolRunOptions } from "../registry.js";
import { selectOutput } from "../output-selection.js";
import {
  webFetchCore,
  type WebFetchCoreOptions,
} from "./fetch-core.js";
import { buildFetchAuditPayload } from "./audit.js";
import {
  TRUNCATION_MARKER,
  type WebFetchArgs,
  type WebFetchOutcome,
} from "./types.js";

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
  const core: WebFetchCoreOptions = {
    ...(options.core ?? {}),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  const outcome = await webFetchCore(args, core);

  void emitAudit(outcome);

  return outcome.ok ? renderSuccess(outcome, args) : renderError(outcome, args);
}

async function emitAudit(outcome: WebFetchOutcome): Promise<void> {
  try {
    await auditLog("tool.web_fetch", buildFetchAuditPayload(outcome));
  } catch {
  }
}

function renderSuccess(
  outcome: WebFetchOutcome,
  args: WebFetchArgs,
): ToolResult {
  const meta = outcome.metadata;
  const part = args.responsePart ?? "full";
  const hasDiagnostics = Boolean(
    meta.headers || meta.tls || meta.timing || meta.redirectChain,
  );
  const summary = `${meta.finalUrl} ${meta.status}${meta.contentType ? ` ${meta.contentType}` : ""}`;
  const second = `mode=${meta.mode}  resolvedIp=${meta.resolvedIp || "?"}  bytes=${meta.bytesReceived}${meta.truncated ? ` (truncated@${meta.truncatedAt ?? meta.bytesReceived})` : ""}`;

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

  const wireTruncationNotice = `[WIRE TRUNCATED at ${(meta.truncatedAt ?? meta.bytesReceived).toLocaleString()} bytes; raise maxBytes for more body]`;
  let output: string;
  if (part === "body") {
    output = meta.truncated
      ? `${outcome.body}\n${wireTruncationNotice}`
      : outcome.body;
  } else if (part === "headers") {
    output = `${summary}\n${second}\n\n${jsonBlock}`;
  } else if (!hasDiagnostics && meta.mode === "readable") {
    output = [
      `URL: ${meta.finalUrl}`,
      `Status: ${meta.status}${meta.contentType ? ` (${meta.contentType})` : ""}`,
      `Bytes: ${meta.bytesReceived}${meta.truncated ? ` (truncated at ${meta.truncatedAt ?? meta.bytesReceived})` : ""}`,
      "",
      "Content:",
      outcome.body,
    ].join("\n");
  } else {
    output = `${summary}\n${second}\n\n${jsonBlock}\n\n---\n${outcome.body}`;
  }

  const renderedOutput = output;
  output = selectOutput(renderedOutput, args);
  if (
    part === "body" &&
    meta.truncated &&
    !output.includes(wireTruncationNotice)
  ) {
    output = selectOutput(
      output ? `${wireTruncationNotice} ${output}` : wireTruncationNotice,
      { maxOutputBytes: args.maxOutputBytes },
    );
  }
  return {
    ok: true,
    output,
    exitCode: 0,
    truncated: meta.truncated || output !== renderedOutput,
    stats: {
      bytesRead: meta.bytesReceived,
      bytesDropped: Math.max(0, Buffer.byteLength(outcome.body) - Buffer.byteLength(output)),
      linesRead: outcome.body.split("\n").length,
      elapsedMs: meta.timing?.totalMs ?? 0,
    },
  };
}

function renderError(
  outcome: WebFetchOutcome,
  args: WebFetchArgs,
): ToolResult {
  const err = outcome.error;
  const head = err?.message ?? "web.fetch failed";
  const body = JSON.stringify(
    {
      error: err,
      requestedUrl: outcome.metadata.requestedUrl,
      finalUrl: outcome.metadata.finalUrl,
      resolvedIp: outcome.metadata.resolvedIp,
      finalHostname: outcome.metadata.finalHostname,
      headers: outcome.metadata.headers,
    },
    null,
    2,
  );
  const renderedOutput =
    args.responsePart === "body"
      ? err?.bodyPreview ?? ""
      : `${head}\n\n${body}`;
  const output = selectOutput(renderedOutput, args);
  return {
    ok: false,
    output,
    truncated:
      output !== renderedOutput ||
      Boolean(err?.bodyPreview?.includes(TRUNCATION_MARKER)),
    exitCode: 1,
  };
}
