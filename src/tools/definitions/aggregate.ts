import type { ToolDefinition } from "../../types.js";
import { TOOL_DEFINITIONS_CONTEXT_1 } from "./context-1.js";
import { TOOL_DEFINITIONS_CONTEXT_2 } from "./context-2.js";
import { def, emptyObject } from "./define.js";
import { TOOL_DEFINITIONS_FILES } from "./files.js";
import { TOOL_DEFINITIONS_NETWORK_1 } from "./network-1.js";
import { TOOL_DEFINITIONS_NETWORK_2 } from "./network-2.js";
import { TOOL_DEFINITIONS_ORCHESTRATION } from "./orchestration.js";
import { TOOL_DEFINITIONS_PENTEST } from "./pentest.js";
import { TOOL_DEFINITIONS_SHELL } from "./shell.js";
import { TOOL_DEFINITIONS_TERMINAL } from "./terminal.js";
import { TOOL_DEFINITIONS_WEB_1 } from "./web-1.js";
import { TOOL_DEFINITIONS_WEB_2 } from "./web-2.js";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...TOOL_DEFINITIONS_FILES,
  ...TOOL_DEFINITIONS_SHELL,
  ...TOOL_DEFINITIONS_NETWORK_1,
  ...TOOL_DEFINITIONS_WEB_1,
  ...TOOL_DEFINITIONS_NETWORK_2,
  ...TOOL_DEFINITIONS_PENTEST,
  ...TOOL_DEFINITIONS_WEB_2,
  ...TOOL_DEFINITIONS_CONTEXT_1,
  ...TOOL_DEFINITIONS_ORCHESTRATION,
  ...TOOL_DEFINITIONS_CONTEXT_2,
  def(
    "skill.load",
    "Read the full instructions of one Agent Skill listed in the AVAILABLE SKILLS block, then follow them. Load a skill when its description covers the work you are about to do — before starting that work, not after. Never guess a skill's contents, never load a skill unrelated to the task, and never load the same skill twice in a session.",
    {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact skill name from the AVAILABLE SKILLS block",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "skill.list",
    "List installed Agent Skills with descriptions and file paths. Use only when the AVAILABLE SKILLS block says entries were omitted, or when you need a skill's directory to read its bundled files.",
    {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional substring filter over name and description",
        },
      },
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "instructions.record",
    'Persist a standing instruction to .clai/INSTRUCTIONS.md so it survives context compaction. Call this as soon as the user states a rule you must keep honoring for the rest of the work — a required style, a forbidden action, a workflow you must repeat (for example "never add comments", "do not push to GitHub", "commit after each change"). One short imperative sentence per entry. Never record task steps, findings, plan items, or anything already in an instruction file. Use remove when the user retracts a rule.',
    {
      type: "object",
      properties: {
        add: {
          type: "array",
          items: { type: "string" },
          description:
            "Standing rules to persist, one imperative sentence each (max 12 per call)",
        },
        remove: {
          type: "array",
          items: { type: "string" },
          description:
            "Existing rules to drop, by their text or 1-based number",
        },
      },
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "plan.clear",
    "Discard the active plan and all its tasks. Use when the plan should no longer be executed, needs full replacement instead of revision, or the work it tracked is being undone. After clearing, no plan exists until the next plan.create.",
    emptyObject,
    { mutates: true },
  ),
  def(
    "plan.create",
    "Create the initial durable plan or revise a draft awaiting approval. If a plan is already approved/in progress, use task.add; runtime preserves it and treats proposed new tasks as append-only.",
    {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "Short plan title (max ~8 words, one line). Not a full sentence or restatement of the user's request — put context/approach in `detail` instead.",
          maxLength: 80,
        },
        detail: { type: "string" },
        tasks: {
          type: "array",
          items: {
            oneOf: [
              { type: "string" },
              {
                type: "object",
                properties: {
                  title: { type: "string" },
                  task: { type: "string" },
                  name: { type: "string" },
                  acceptanceCriteria: {
                    type: "string",
                    description:
                      "Observable evidence required before this task is done; state the outcome, not a preferred tool command.",
                  },
                  dependencies: {
                    type: "array",
                    items: { type: "string" },
                    description: "Task ids or aliases that must finish first",
                  },
                  resourceLocks: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "Optional shared resources that prevent unsafe overlap",
                  },
                },
              },
            ],
          },
        },
        kind: {
          type: "string",
          description:
            'REQUIRED category for this plan — you decide it from the actual work, never leave it generic and never default to "general". Use one concise lowercase word (rarely two) naming the primary activity. Pick the most specific fitting label; invent a better one when none below fits. Building/coding: build, frontend, ui, webapp, api, backend, feature, refactor, bugfix, fix, debugging, testing, perf, devops, infra, deployment, migration, docs, config. Data/research: data, research, analysis. Security: security, pentest, reconnaissance, recon, osint, exploit, audit, hardening, forensics. Choose "general" ONLY when the work truly spans many categories with no dominant one.',
        },
      },
      required: ["goal", "tasks", "kind"],
      additionalProperties: true,
    },
    { mutates: true },
  ),
  def(
    "task.add",
    "Append one newly discovered task or child task to the active plan without rewriting existing tasks or reopening completed work.",
    {
      type: "object",
      properties: {
        title: { type: "string" },
        parentTaskId: {
          type: "string",
          description: "Optional canonical parent id from ACTIVE PLAN",
        },
        dependencies: {
          type: "array",
          items: { type: "string" },
          description: "Optional canonical task ids that must finish first",
        },
        resourceLocks: {
          type: "array",
          items: { type: "string" },
        },
        note: { type: "string" },
        acceptanceCriteria: {
          type: "string",
          description:
            "Observable evidence required before this task is done; describe the outcome rather than prescribing a tool.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "task.move",
    "Move an existing task without changing its id, state, evidence, or responder linkage. Use one of position, beforeTaskId, or afterTaskId.",
    {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Canonical task id or listed alias",
        },
        position: {
          type: "number",
          description:
            "One-based destination, for example taskId=t2 position=4",
        },
        beforeTaskId: { type: "string" },
        afterTaskId: { type: "string" },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "job.read",
    "Mark one delivered Responder job result read after analysis. This is plan-independent and mandatory before a final response. Identify the receipt by jobId or notificationId; reading atomically records delivery and prevents duplicate notification of the same result revision.",
    {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "Canonical background job id from the delivered result",
        },
        notificationId: {
          type: "string",
          description:
            "Exact notification id from the delivered Responder result",
        },
      },
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "task.read",
    "Compatibility alias for job.read using notificationId. It does not require an active plan. Call only after analyzing the delivered Responder result.",
    {
      type: "object",
      properties: {
        notificationId: {
          type: "string",
          description:
            "Exact notification id from the Responder inbox entry you finished analyzing",
        },
      },
      required: ["notificationId"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "task.update",
    'Update a plan task state. taskId MUST be t1, t2, … from the ACTIVE PLAN context (not a free-form title slug). Use state:"pending" to defer an in-progress foreground task before opening a different one.',
    {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description:
            "Canonical id from plan context: t1, t2, t3, … (aliases accepted if listed)",
        },
        state: {
          type: "string",
          enum: ["pending", "in_progress", "done", "failed", "skipped"],
        },
        note: { type: "string" },
      },
      required: ["taskId", "state"],
      additionalProperties: true,
    },
    { mutates: true },
  ),
  def(
    "agent.handoff",
    "Hand a task that needs agent mode (writes, shell, installs) back to the user. Ask mode cannot execute mutations — use this instead of inventing write tools.",
    {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Exact task restatement for agent mode",
        },
        reason: {
          type: "string",
          description: "Short reason agent mode is required",
        },
      },
      required: ["task", "reason"],
      additionalProperties: false,
    },
  ),
  def(
    "loop.reset",
    "Reset the action-sequence loop counter so a repeated command is not blocked. Call this ONLY when you are genuinely iterating (e.g. re-running a test after editing source) and the loop guard warned you. Do not call preemptively.",
    {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  ),
  def(
    "mcp.list",
    "List configured MCP servers, their live connection status, and the current per-session selection. Read-only. Use this to discover what MCP capability is available before enabling or calling a server.",
    emptyObject,
    { readOnly: true, askMode: true },
  ),
  def(
    "mcp.tools",
    "List the tools exposed by connected MCP servers, with each tool's dotted name and whether it is read-only. Optionally filter to one server. Read-only.",
    {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server name to filter the tool list.",
        },
      },
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "mcp.enable",
    'Enable MCP tools for this session so their tools become callable. Pass server (one name) or servers (several names) to select specific servers, "all" to enable every live server, or "off" to disable. Changes only this session\'s selection; it never edits configuration.',
    {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: 'One server name, or "all" / "off".',
        },
        servers: {
          type: "array",
          items: { type: "string" },
          description: "Several server names to enable together.",
        },
      },
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "mcp.connect",
    "Connect or reconnect one configured MCP server and report its resulting status. Use after editing configuration or when a server shows as error/degraded.",
    {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "MCP server name to (re)connect.",
        },
      },
      required: ["server"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "mcp.login",
    "Run the OAuth sign-in flow for one MCP server that returned 401/requires authorization. Opens a browser for consent, stores the resulting token, and reconnects. Use when mcp.connect reports the server needs authentication.",
    {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "MCP server name to authenticate.",
        },
      },
      required: ["server"],
      additionalProperties: false,
    },
    { mutates: true },
  ),
  ...TOOL_DEFINITIONS_TERMINAL,
];
