import type { ToolDefinition } from "../../types.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_TERMINAL: ToolDefinition[] = [
  def(
    "terminal.start",
    "Start a conversation-owned interactive process or REPL and return its session id and output cursor. Use for programs that need later input; use shell.exec for finite commands and shell.start for unattended services.",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        terminalMode: {
          type: "string",
          enum: ["required", "preferred", "pipe"],
          description:
            "preferred uses a PTY when available and otherwise pipes; required refuses fallback; pipe always uses managed pipes",
        },
        columns: { type: "integer" },
        rows: { type: "integer" },
        idleTimeoutMs: { type: "integer" },
        lifetimeTimeoutMs: { type: "integer" },
        deadlineMs: { type: "integer" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "terminal.send",
    "Send exactly one text, secret, control, or EOF action to an interactive session, then return output after quiet, exit, or deadline. Secret input is prompted locally and must never be supplied in tool arguments. Continue from nextCursor; never resend when delivery is unknown or a delivered action times out while gathering output.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["text", "secret", "control", "eof"] },
        text: { type: "string" },
        secretPrompt: { type: "string" },
        submit: { type: "string", enum: ["enter", "none"] },
        control: {
          type: "string",
          enum: [
            "interrupt",
            "eof",
            "suspend",
            "escape",
            "tab",
            "backspace",
            "up",
            "down",
            "left",
            "right",
          ],
        },
        cursor: { type: "integer" },
        quietMs: { type: "integer" },
        deadlineMs: { type: "integer" },
        view: { type: "string", enum: ["plain", "encoded"] },
      },
      required: ["id", "kind"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "terminal.read",
    "Read session output from an exact cursor without sending input. Use nextCursor for gap-free continuation; waitMs may wait up to 30000ms for new output.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        cursor: { type: "integer" },
        waitMs: { type: "integer" },
        view: { type: "string", enum: ["plain", "encoded"] },
      },
      required: ["id", "cursor"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "terminal.status",
    "Return current state, cursor range, transport, and process outcome for one interactive session.",
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
    "List interactive sessions owned by this conversation, with live sessions first.",
    emptyObject,
    { readOnly: true },
  ),
  def(
    "terminal.resize",
    "Resize a PTY-backed interactive session.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        columns: { type: "integer" },
        rows: { type: "integer" },
      },
      required: ["id", "columns", "rows"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "terminal.close",
    "Close an interactive session, terminate its process tree, and verify cleanup. Repeated close calls return the recorded terminal result.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        deadlineMs: { type: "integer" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
];
