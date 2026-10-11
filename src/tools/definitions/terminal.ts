import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";
import { INTERACTIVE_SESSION_DEFAULTS, INTERACTIVE_SESSION_RANGES, type RangedConfigField } from "../../interactive-session/config.js";

function milliseconds(field: RangedConfigField, description: string) {
  const range = INTERACTIVE_SESSION_RANGES[field];
  const value = INTERACTIVE_SESSION_DEFAULTS[field];
  return {
    type: "integer", minimum: range.min, maximum: range.max, description,
    ...(value === undefined ? {} : { default: value }),
  };
}

const outputView = {
  type: "string", enum: ["plain", "encoded"],
  description: "plain: linear text, not screen; encoded: each event as base64.",
};
const outputCursor = {
  type: "integer", minimum: 0,
  description: "Redacted byte cursor: nextCursor resumes; ≤latestCursor.",
};

export const TOOL_DEFINITIONS_TERMINAL: ToolDefinition[] = [
  def(
    "terminal.start",
    "Owned SSH/Python/msfconsole REPL. Read until prompt before input. Output after ≤1000ms. Finite work: shell.exec; unattended services: shell.exec background:\"always\".",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        terminalMode: {
          type: "string", enum: ["required", "preferred", "pipe"],
          description: "required: PTY or fail (SSH/readline); preferred: PTY/pipes; pipe: stdin only.",
        },
        columns: { type: "integer", minimum: 2, maximum: 1000, default: 80 },
        rows: { type: "integer", minimum: 2, maximum: 1000, default: 24 },
        idleTimeoutMs: milliseconds("idleTimeoutMs", "Optional idle cap; I/O resets it. Avoid short caps for passwords."),
        lifetimeTimeoutMs: milliseconds("lifetimeTimeoutMs", "Optional absolute cap; never extended."),
        deadlineMs: milliseconds("startDeadlineMs", "Limits launch only, never session lifetime. Timeouts are ms."),
      },
      required: ["command"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "terminal.send",
    "Send once; never resend delivered/unknown input. Read nextCursor. Secrets never in args.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["text", "secret", "control", "eof"] },
        text: { type: "string", description: "text only; never passwords." },
        secretPrompt: { type: "string", description: "secret only: nonsecret masked-input label." },
        secretSource: { type: "string", enum: ["auto", "user", "prompt"], default: "auto", description: "auto: one user password or masked input; user requires it; prompt: masked input only." },
        submit: { type: "string", enum: ["enter", "none"], default: "enter", description: "text/secret: enter adds Enter (omit trailing newline); none types only." },
        control: {
          type: "string",
          enum: ["interrupt", "eof", "suspend", "escape", "tab", "backspace", "up", "down", "left", "right"],
        },
        cursor: outputCursor,
        quietMs: milliseconds("quietIntervalMs", "Output pause in ms, not command completion."),
        deadlineMs: milliseconds("sendDeadlineMs", "I/O deadline in ms."),
        view: outputView,
      },
      required: ["id", "kind"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "terminal.read",
    "Read after exit/close; drain hasMore via nextCursor. OUTPUT_GAP: earliestAvailableCursor/artifact. Pre-secret exit ≠ bad credentials.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        cursor: outputCursor,
        waitMs: { type: "integer", minimum: 0, maximum: 30000, default: 0, description: "Output wait in ms; exited sessions return immediately." },
        view: outputView,
      },
      required: ["id", "cursor"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "terminal.status",
    "State, byte-cursors, transport and process outcome.",
    {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "terminal.list",
    "List owned sessions, live first.",
    emptyObject,
    { readOnly: true },
  ),
  def(
    "terminal.close",
    "Terminate owned process tree; idempotent. Verify cleanupVerified.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        deadlineMs: milliseconds("closeDeadlineMs", "Cleanup deadline in ms."),
      },
      required: ["id"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
];
