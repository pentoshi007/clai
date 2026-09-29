import type { ToolDefinition } from "../../types.js";
import { toSnakeWireName, toWireName } from "../../llm/tool-protocol.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_SHELL: ToolDefinition[] = [
  def(
    "shell.exec",
    'Run a shell command. Default timeoutMs is 40000; choose a larger timeout for builds, installs, scaffolds, scans, and searches. Known long installs get a safe automatic budget when omitted. Persistent servers, watchers, and listeners: background:"always" with a name; they auto-launch as normal background jobs that need shell.tail/shell.jobs plus a readiness probe. Choose responder:true for a fire-and-continue finite job with automatic terminal delivery. Pass background:"never" to force foreground and honor timeoutMs. Pass cwd instead of cd.',
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "integer" },
        name: {
          type: "string",
          description: "Short label for a background job, e.g. \"api dev server\".",
        },
        background: {
          type: "string",
          enum: ["auto", "never", "always"],
          description:
            "auto (default): run finite commands in the foreground and persistent commands in the background. never: always run in the foreground and honor timeoutMs. always: always run as a durable pollable job.",
        },
        responder: {
          type: "boolean",
          description:
            'Execution ownership for finite work. true: Responder fire-and-continue with automatic terminal delivery. false or omitted: keep foreground execution unless background:"always" explicitly requests a normal pollable job.',
        },
        parentTaskId: {
          type: "string",
          description:
            'Plan task id that owns this delegation (e.g. "t3"). Required whenever more than one task could own it; the Responder child is created under exactly this task.',
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "shell.jobs",
    "List durable background jobs for this session, with running jobs first. Use before starting another long command and before finishing a task with outstanding jobs.",
    emptyObject,
    { readOnly: true },
  ),
  def(
    "shell.tail",
    "Read status and captured output from a tracked background job. For incremental polling, use stdout (default) or stderr and pass that stream's prior nextOffset as offset; continue until status is exited, failed, killed, or lost. combined is snapshot-only and rejects offset because its concatenated boundary is not a stable cursor.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        bytes: { type: "integer" },
        offset: {
          type: "integer",
          description:
            "Byte offset from the prior shell.tail nextOffset (default: recent tail)",
        },
        stream: {
          type: "string",
          enum: ["stdout", "stderr", "combined"],
          description: "Captured stream to read (default stdout)",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
  def(
    "shell.stop",
    "Stop a durable background job by id, verify termination, and persist the terminal status.",
    {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "shell.wait",
    "Block until a tracked background job reaches a terminal state (exited, failed, killed, lost), then return its exit code and output tail in one call. Use this instead of polling shell.jobs or shell.tail in a loop for a finite command such as a build, test run, or `gh run watch`: one shell.wait replaces every poll. If the wait times out the job is left running and you are told so; do other useful work and wait again with a larger timeoutMs. Never use this on a persistent server that has no terminal state.",
    {
      type: "object",
      properties: {
        id: { type: "string" },
        timeoutMs: {
          type: "integer",
          description: "Maximum time to block (default 120000, max 600000)",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    { readOnly: true },
  ),
];
