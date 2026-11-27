import type { ToolDefinition } from "../../types.js";
import { TOOL_DEFINITIONS_CONTEXT_2 } from "./context-2.js";
import { TOOL_DEFINITIONS_CREDENTIALS } from "./credentials.js";
import { def, emptyObject } from "./define.js";
import { TOOL_DEFINITIONS_FILES } from "./files.js";
import { TOOL_DEFINITIONS_SHELL } from "./shell.js";
import { TOOL_DEFINITIONS_TERMINAL } from "./terminal.js";
import { TOOL_DEFINITIONS_SUBAGENTS } from "./subagents.js";
import { TOOL_DEFINITIONS_WEB_1 } from "./web-1.js";
import { TOOL_DEFINITIONS_WEB_2 } from "./web-2.js";
import { TASK_UPDATE_LIMIT, TASK_UPDATE_STATES } from "../task-update.js";
import { TURN_END_REASONS, TURN_END_TOOL_NAME } from "../turn-end.js";
import {
  USER_ASK_HEADER_MAX_CHARS,
  USER_ASK_MAX_OPTIONS,
  USER_ASK_MAX_QUESTIONS,
  USER_ASK_MIN_OPTIONS,
  USER_ASK_TOOL_NAME,
} from "../user-ask.js";

const taskSteps = {
  type: "array",
  items: { type: "string" },
  description:
    "Concrete implementation steps: the files, symbols or assets, the exact change or test, edge cases, and the check that proves it",
};

const newTaskProperties = {
  title: { type: "string" },
  parentTaskId: { type: "string", description: "Parent ID or alias" },
  dependencies: { type: "array", items: { type: "string" }, description: "Prerequisite IDs or aliases" },
  resourceLocks: { type: "array", items: { type: "string" } },
  steps: taskSteps,
  note: { type: "string" },
  acceptanceCriteria: { type: "string", description: "Evidence required for completion" },
};

const taskBatch = {
  type: "array",
  minItems: 1,
  description: "New tasks in dependency order. Refer to existing or earlier tasks by ID or lowercase_underscore alias.",
  items: {
    oneOf: [
      { type: "string" },
      { type: "object", properties: newTaskProperties, required: ["title"], additionalProperties: false },
    ],
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...TOOL_DEFINITIONS_FILES,
  ...TOOL_DEFINITIONS_SHELL,
  ...TOOL_DEFINITIONS_WEB_1,
  ...TOOL_DEFINITIONS_WEB_2,
  ...TOOL_DEFINITIONS_CONTEXT_2,
  ...TOOL_DEFINITIONS_CREDENTIALS,
  ...TOOL_DEFINITIONS_SUBAGENTS,
  def(
    "skill.load",
    "Read the full instructions of one applicable Agent Skill before starting that work, then follow them. Never guess its contents or load unrelated skills. Avoid reloading while the full instructions remain in live context; after compaction, reload still-relevant skills whose bodies were lost and re-read their applicable references with fs.read.",
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
    "Persist reusable project-wide rules in .clai/INSTRUCTIONS.md, never one-off requirements; skip when none qualify. Follow PERSISTENT PROJECT INSTRUCTIONS.",
    {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["project"],
          description:
            "Required for reusable project-wide additions; omit for removals.",
        },
        add: {
          type: "array",
          items: { type: "string" },
          description:
            "One short imperative sentence per reusable rule (max 12 per call)",
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
    USER_ASK_TOOL_NAME,
    "Ask the user up to three decision questions and wait for the answers. Use it only for decisions that the request, the code, and sensible defaults cannot settle and that would materially change scope, design, or risk; decide everything else yourself. Investigate first so the options are grounded, put every open decision into one call, and list the option you recommend first with \"(Recommended)\" in its label. The user can always type a different answer.",
    {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: USER_ASK_MAX_QUESTIONS,
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "One clear question" },
              header: {
                type: "string",
                maxLength: USER_ASK_HEADER_MAX_CHARS,
                description: "Short label such as Auth, Storage, or Scope",
              },
              options: {
                type: "array",
                minItems: USER_ASK_MIN_OPTIONS,
                maxItems: USER_ASK_MAX_OPTIONS,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "One to five words" },
                    description: { type: "string", description: "One-line trade-off" },
                  },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: "boolean", description: "Allow choosing several options" },
            },
            required: ["question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    { askMode: true },
  ),
  def(
    "plan.clear",
    "Discard the active plan and all its tasks. Use when the plan should no longer be executed, needs full replacement instead of revision, or the work it tracked is being undone. After clearing, no plan exists until the next plan.create.",
    emptyObject,
    { mutates: true },
  ),
  def(
    "plan.create",
    "Start a plan or revise an unapproved draft. For follow-ups use plan.update or batched task.add. In plan mode every task needs steps and acceptanceCriteria, and detail carries the durable brief.",
    {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description: "One short title (about eight words); put context in detail.",
          maxLength: 80,
        },
        detail: {
          type: "string",
          description: "Durable brief that survives compaction: scope, evidence, affected surfaces, decisions, risks, and validation.",
        },
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
                  steps: taskSteps,
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
          description: "Specific lowercase category for the primary work (e.g. feature, bugfix, testing, docs, analysis, audit). Use general only when no category dominates.",
        },
      },
      required: ["goal", "tasks", "kind"],
      additionalProperties: true,
    },
    { mutates: true },
  ),
  def(
    "task.add",
    "Batch new tasks in one call. For one task, title and its fields also work; don't mix forms. Use plan.update if title/detail changes.",
    {
      type: "object",
      properties: { ...newTaskProperties, tasks: taskBatch },
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "plan.update",
    "Update title/detail and/or batch new tasks in one call, even after completion. Existing tasks, approval, and omitted fields stay unchanged.",
    {
      type: "object",
      properties: {
        goal: {
          type: "string",
          maxLength: 80,
          description: "Short title covering old and new scope (about eight words), not a list.",
        },
        detail: { type: "string", description: "Keep constraints still in force." },
        tasks: taskBatch,
      },
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
    TURN_END_TOOL_NAME,
    "Declare that this turn is finished. The response that ends a turn must contain both your final message to the user and this call: write the message, then call turn.end in that same response, alone or with plan/job bookkeeping calls only. A final message sent without it costs an extra request to confirm the turn is over. Judge only against the latest user message: call it when that request is fully handled (work done and verified, or the question answered, which needs no other tools), when you need the user's input, confirmation or decision, when a genuine blocker needs the user's attention, or when the user told you to stop at this point. Never call it to pause work you can still do yourself. The declaration covers only this response: any later tool work requires a new declaration, and every new user message starts undeclared.",
    {
      type: "object",
      properties: {
        reason: {
          type: "string",
          enum: [...TURN_END_REASONS],
          description:
            "completed: requested work is done and verified; answered: the question or request was answered; needs_user_input: you need the user's input, confirmation or decision; blocked: a blocker needs the user's attention; stop_requested: the user asked you to stop here",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
  ),
  def(
    "job.read",
    "Mark one delivered Responder job result read after analysis. This is plan-independent and mandatory before a final response. Identify the receipt by jobId or notificationId; reading atomically records delivery and prevents duplicate notification of the same result revision. Pass summary with the conclusion later work depends on: it is kept across context compaction in place of the raw output.",
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
        summary: {
          type: "string",
          description:
            "One or two sentences: the key findings of this result that later work depends on (not raw output). Recorded when the result is marked read and carried through context compaction.",
        },
      },
      additionalProperties: false,
    },
    { mutates: true },
  ),
  def(
    "task.update",
    "Update one foreground task with taskId/state/note, or batch ready changes atomically with updates. Mark each task done only after verifying its own acceptance criteria; never mark unfinished or unverified tasks done. Never update Responder-owned tasks.",
    {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task id or listed alias from ACTIVE PLAN (single-task form)",
        },
        state: { type: "string", enum: TASK_UPDATE_STATES },
        note: { type: "string" },
        updates: {
          type: "array",
          description: `Groups of task ids sharing a state and optional note. At most ${TASK_UPDATE_LIMIT} distinct tasks total. Do not combine with single-task fields.`,
          minItems: 1,
          maxItems: TASK_UPDATE_LIMIT,
          items: {
            type: "object",
            properties: {
              state: { type: "string", enum: TASK_UPDATE_STATES },
              taskIds: {
                type: "array",
                minItems: 1,
                maxItems: TASK_UPDATE_LIMIT,
                items: { type: "string" },
              },
              note: { type: "string" },
            },
            required: ["state", "taskIds"],
            additionalProperties: false,
          },
        },
      },
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
    "rea.manage",
    "Reverse Engineer Anything (REA) for shipped artifacts: native binaries, Electron/JS apps, .NET, Android, firmware, captures, requested runtime evidence; never source repositories. status/guide are read-only; install/setup/update/enable/disable/reconnect change state. Flow: enable (setup if missing) returns the workflow and tool index, then mcp.call; mcp.tools server=clai-rea reads full schemas. reconnect resets the live analysis: only after a connection fault.",
    {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "install", "setup", "update", "enable", "disable", "reconnect", "guide"] },
      },
      required: ["action"],
      additionalProperties: false,
    },
    { mutates: true, askMode: true },
  ),
  def(
    "mcp.list",
    "List configured MCP servers, their live connection status, and the current per-session selection. Read-only. Use this to discover what MCP capability is available before enabling or calling a server.",
    emptyObject,
    { readOnly: true, askMode: true },
  ),
  def(
    "mcp.tools",
    "Search connected MCP tools by query and optional server. Returns dotted names, complete compact argument schemas, and read-only status in bounded pages. Follow the returned cursor with the same query and server. Read-only.",
    {
      type: "object",
      properties: {
        server: {
          type: "string",
          description: "Optional MCP server name to filter the tool list.",
        },
        query: { type: "string", description: "Words to match in tool names and descriptions." },
        cursor: { type: "string", description: "Next cursor from the previous page with the same server and query." },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Maximum tools in this page; default 12." },
      },
      additionalProperties: false,
    },
    { readOnly: true, askMode: true },
  ),
  def(
    "mcp.call",
    "Call one active MCP tool using its exact dotted name and an arguments object matching MCP TOOL CONTEXT or mcp.tools. Ask mode permits only read-only targets. Normal confirmation policy applies to mutations.",
    {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Exact dotted MCP tool name from MCP TOOL CONTEXT.",
        },
        arguments: {
          type: "object",
          description: "Arguments for that MCP tool, matching its listed schema.",
          additionalProperties: true,
        },
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    },
    { mutates: true, askMode: true },
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
  def(
    "mcp.add",
    'Add an MCP server to this project. Pass name with a well-known server id from the built-in catalog (github, notion, context7, fetch, filesystem, memory, sequential-thinking, brave-search, mongodb, puppeteer, slack) for a curated one-step install, or pass json with a full server definition. Required API keys must already exist as environment variables; otherwise the call reports exactly which variable to set.',
    {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Well-known server id from the built-in catalog.",
        },
        json: {
          type: "string",
          description:
            'Full server definition as JSON, e.g. {"docs":{"command":"docs-server"}} or a named single server object.',
        },
      },
      additionalProperties: false,
    },
    { mutates: true },
  ),
  ...TOOL_DEFINITIONS_TERMINAL,
];
