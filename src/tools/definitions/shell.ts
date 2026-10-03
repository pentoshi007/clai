import type { ToolDefinition } from "../../types.js";
import { toSnakeWireName, toWireName } from "../../llm/tool-protocol.js";
import { def, emptyObject } from "./define.js";

export const TOOL_DEFINITIONS_SHELL: ToolDefinition[] = [
  def(
    "shell.exec",
    'Run a shell command in the foreground by default; commands are never automatically backgrounded. You choose execution mode and foreground timeoutMs in milliseconds. Foreground default is 60000; set a sufficient budget for builds, installs, scans and searches. background:"always" explicitly starts a durable pollable job; use shell.wait for finite jobs. Persistent servers, watchers, and listeners: background:"always" with a name; use shell.tail plus a readiness probe and shell.stop for cleanup. responder:true explicitly delegates finite work with automatic terminal delivery; do independent work instead of polling, then analyze the result and call job.read. background:"never" overrides responder. timeoutMs is ignored for background and Responder jobs; authorization expiry remains enforced. Pass cwd instead of cd.',
    {
      type: "object",
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: {
          type: "integer",
          description: "Foreground execution deadline in milliseconds (1000–1800000; default 60000). Ignored for background and Responder jobs, which have no execution deadline. No command-based budget or seconds conversion.",
        },
        name: {
          type: "string",
          description: "Short label for a background job, e.g. \"api dev server\".",
        },
        background: {
          type: "string",
          enum: ["auto", "never", "always"],
          description:
            'Omitted or auto (legacy compatibility): foreground unless responder:true is explicitly chosen; no heuristic backgrounding. never: force foreground even with responder:true. always: explicitly start a durable job, pollable unless responder:true.',
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
