/**
 * Tool adapter for the seven additive `terminal.*` operations.
 *
 * Existing shell and job tools are untouched. Every handler requires an owning
 * conversation id, projects a concise ANSI-free `output` for providers and
 * transcripts, and returns the structured result under `interactiveSession`.
 */

import { loadScopeForSession, type EngagementScope } from "../store/scope.js";
import {
  InteractiveSessionManager,
  interactiveSessionManager,
  type ConfirmPreview,
} from "../interactive-session/manager.js";
import {
  isInteractiveSessionsEnabled,
  resolveInteractiveSessionConfig,
} from "../interactive-session/config.js";
import {
  asStableError,
  type ControlInput,
  type InteractiveSessionToolResult,
  type OutputPage,
  type OutputView,
  type SessionInput,
  type SessionOperation,
  type StableError,
} from "../interactive-session/types.js";
import { CONTROL_INPUTS } from "../interactive-session/types.js";
import type { ToolResult } from "../types.js";
import type { ToolHandler, ToolRunOptions } from "./tool-types.js";

export const INTERACTIVE_SESSION_TOOL_NAMES = [
  "terminal.start",
  "terminal.send",
  "terminal.read",
  "terminal.status",
  "terminal.list",
  "terminal.resize",
  "terminal.close",
] as const;

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalView(args: Record<string, unknown>): OutputView | undefined {
  const value = optionalString(args, "view");
  if (value === undefined) return undefined;
  if (value !== "plain" && value !== "encoded") {
    throw new Error("view must be plain or encoded");
  }
  return value;
}

/** Strict validation of the dependent send fields before the manager sees them. */
async function parseInput(
  args: Record<string, unknown>,
  options: ToolRunOptions | undefined,
): Promise<SessionInput> {
  const kind = requireString(args, "kind");
  if (kind === "text") {
    const text = args.text;
    if (typeof text !== "string") throw new Error("text is required when kind is text");
    if (args.control !== undefined) throw new Error("control is not allowed when kind is text");
    const submit = optionalString(args, "submit") ?? "enter";
    if (submit !== "enter" && submit !== "none") {
      throw new Error("submit must be enter or none");
    }
    return { kind: "text", text, submit };
  }
  if (kind === "secret") {
    if (args.text !== undefined || args.control !== undefined) {
      throw new Error("text and control are not allowed when kind is secret");
    }
    const submit = optionalString(args, "submit") ?? "enter";
    if (submit !== "enter" && submit !== "none") {
      throw new Error("submit must be enter or none");
    }
    const secretPrompt = optionalString(args, "secretPrompt") ?? "Enter secret";
    const value = await options?.requestSecret?.({
      title: "Terminal secret input",
      prompt: secretPrompt,
    });
    if (value === undefined) throw new Error("Secret input was cancelled");
    return { kind: "secret", value, submit };
  }
  if (kind === "control") {
    const control = requireString(args, "control");
    if (args.text !== undefined) throw new Error("text is not allowed when kind is control");
    if (!CONTROL_INPUTS.includes(control as ControlInput)) {
      throw new Error(`control must be one of: ${CONTROL_INPUTS.join(", ")}`);
    }
    return { kind: "control", control: control as ControlInput };
  }
  if (kind === "eof") {
    if (args.text !== undefined || args.control !== undefined) {
      throw new Error("text and control are not allowed when kind is eof");
    }
    return { kind: "eof" };
  }
  throw new Error("kind must be text, secret, control, or eof");
}

async function activeScope(
  options: ToolRunOptions | undefined,
): Promise<EngagementScope | undefined> {
  return loadScopeForSession(options?.sessionId);
}

function requireOwner(options: ToolRunOptions | undefined, operation: SessionOperation): string {
  const ownerId = options?.sessionId;
  if (typeof ownerId === "string" && ownerId.length > 0) return ownerId;
  throw new Error(
    `terminal.${operation} requires an active clai session that owns the interactive session`,
  );
}

/**
 * Interactive confirmation. The runner already prompted when it marked the call
 * confirmed; otherwise the managed secret/confirm path is unavailable and a
 * `confirm`-level action is refused rather than silently delivered.
 */
function confirmPort(options: ToolRunOptions | undefined): ConfirmPreview {
  return async () => options?.confirmed === true;
}

function summarizePage(page: OutputPage | undefined): string[] {
  if (!page) return [];
  const lines: string[] = [];
  const body = page.events.map((event) => event.content).join("");
  if (body.length > 0) lines.push(body.replace(/\s+$/, ""));
  lines.push(
    `[cursor ${page.requestedCursor}→${page.nextCursor}${page.hasMore ? " more" : ""}${
      page.decodingLoss ? " lossy" : ""
    }${page.omittedBytes ? ` omitted=${page.omittedBytes}B` : ""}]`,
  );
  return lines;
}

function describeError(error: StableError): string {
  return `[${error.code}] ${error.message} (retryable=${error.retryable})`;
}

function project(result: InteractiveSessionToolResult): ToolResult {
  const lines: string[] = [];
  let ok = true;
  switch (result.operation) {
    case "start":
      lines.push(
        `session ${result.sessionId} ${result.state} transport=${result.transport}` +
          (result.dimensions
            ? ` ${result.dimensions.columns}x${result.dimensions.rows}`
            : "") +
          (result.degradedReason ? ` degraded=${result.degradedReason}` : ""),
        `artifact=${result.artifact.path}`,
      );
      break;
    case "send":
      lines.push(
        `seq=${result.inputSequence} delivery=${result.delivery} bytes=${result.deliveredBytes} state=${result.state}`,
        ...summarizePage(result.page),
      );
      if (result.error) {
        ok = false;
        lines.push(describeError(result.error));
      }
      break;
    case "read":
      lines.push(`state=${result.state}`, ...summarizePage(result.page));
      if (result.error) {
        ok = false;
        lines.push(describeError(result.error));
      }
      break;
    case "status": {
      const session = result.session;
      lines.push(
        `${session.id} ${session.state} transport=${session.transport} cursor=${session.earliestCursor}..${session.latestCursor}` +
          (session.inputClosed ? " input=closed" : "") +
          (session.terminationReason ? ` reason=${session.terminationReason}` : ""),
      );
      break;
    }
    case "list":
      lines.push(
        result.sessions.length === 0
          ? "No interactive sessions for this conversation."
          : result.sessions
              .map(
                (session) =>
                  `${session.id} ${session.state} transport=${session.transport} latestCursor=${session.latestCursor}`,
              )
              .join("\n"),
      );
      break;
    case "resize":
      lines.push(
        `${result.sessionId} resized to ${result.dimensions.columns}x${result.dimensions.rows} (${result.state})`,
      );
      break;
    case "close":
      lines.push(
        `${result.sessionId} ${result.state}` +
          (result.terminationReason ? ` reason=${result.terminationReason}` : "") +
          ` cleanupVerified=${result.cleanupVerified}`,
      );
      if (result.error) {
        ok = false;
        lines.push(describeError(result.error));
      }
      break;
  }
  return { ok, output: lines.filter((line) => line.length > 0).join("\n"), interactiveSession: result };
}

function failure(error: unknown, operation: SessionOperation): ToolResult {
  const stable = asStableError(error, {
    code: "INVALID_REQUEST",
    operation,
    message: error instanceof Error ? error.message : "Invalid interactive session request.",
  });
  return { ok: false, output: describeError(stable), exitCode: 1 };
}

async function guarded(
  operation: SessionOperation,
  run: () => Promise<InteractiveSessionToolResult> | InteractiveSessionToolResult,
): Promise<ToolResult> {
  try {
    if (!isInteractiveSessionsEnabled(resolveInteractiveSessionConfig())) {
      return {
        ok: false,
        output:
          "Interactive terminal sessions are disabled. Use shell.exec or shell.start instead.",
        exitCode: 1,
      };
    }
    return project(await run());
  } catch (error) {
    return failure(error, operation);
  }
}

export function createInteractiveSessionHandlers(
  manager: InteractiveSessionManager = interactiveSessionManager,
): Record<(typeof INTERACTIVE_SESSION_TOOL_NAMES)[number], ToolHandler> {
  return {
    "terminal.start": async (args, options) =>
      guarded("start", async () => {
        const ownerId = requireOwner(options, "start");
        const mode = optionalString(args, "terminalMode");
        return await manager.start({
          ownerId,
          command: requireString(args, "command"),
          cwd: optionalString(args, "cwd"),
          terminalMode: mode as "required" | "preferred" | "pipe" | undefined,
          columns: optionalNumber(args, "columns"),
          rows: optionalNumber(args, "rows"),
          idleTimeoutMs: optionalNumber(args, "idleTimeoutMs"),
          lifetimeTimeoutMs: optionalNumber(args, "lifetimeTimeoutMs"),
          deadlineMs: optionalNumber(args, "deadlineMs"),
          signal: options?.signal,
          confirm: confirmPort(options),
          scope: await activeScope(options),
        });
      }),
    "terminal.send": async (args, options) =>
      guarded("send", async () => {
        const ownerId = requireOwner(options, "send");
        return await manager.send({
          ownerId,
          id: requireString(args, "id"),
          input: await parseInput(args, options),
          cursor: optionalNumber(args, "cursor"),
          quietMs: optionalNumber(args, "quietMs"),
          deadlineMs: optionalNumber(args, "deadlineMs"),
          view: optionalView(args),
          signal: options?.signal,
          confirm: confirmPort(options),
          scope: await activeScope(options),
        });
      }),
    "terminal.read": async (args, options) =>
      guarded("read", async () => {
        const ownerId = requireOwner(options, "read");
        const cursor = optionalNumber(args, "cursor");
        if (cursor === undefined) throw new Error("cursor is required");
        return await manager.read({
          ownerId,
          id: requireString(args, "id"),
          cursor,
          waitMs: optionalNumber(args, "waitMs"),
          view: optionalView(args),
          signal: options?.signal,
        });
      }),
    "terminal.status": async (args, options) =>
      guarded("status", () =>
        manager.status({
          ownerId: requireOwner(options, "status"),
          id: requireString(args, "id"),
        }),
      ),
    "terminal.list": async (_args, options) =>
      guarded("list", () => manager.list({ ownerId: requireOwner(options, "list") })),
    "terminal.resize": async (args, options) =>
      guarded("resize", async () => {
        const columns = optionalNumber(args, "columns");
        const rows = optionalNumber(args, "rows");
        if (columns === undefined || rows === undefined) {
          throw new Error("columns and rows are required");
        }
        return await manager.resize({
          ownerId: requireOwner(options, "resize"),
          id: requireString(args, "id"),
          columns,
          rows,
        });
      }),
    "terminal.close": async (args, options) =>
      guarded("close", async () =>
        await manager.close({
          ownerId: requireOwner(options, "close"),
          id: requireString(args, "id"),
          deadlineMs: optionalNumber(args, "deadlineMs"),
        }),
      ),
  };
}
