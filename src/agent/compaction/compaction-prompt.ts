import type { ChatMessage } from "../../types.js";
import { compactionPromptAnchors, hasCompletedConversationTurn } from "../context/compaction-recent-history.js";
import { inheritedInstructionAnchors } from "../context/compaction-user-instructions.js";
import {
  ACTIVE_GOAL_HEADING,
  CONTEXT_GATHERED_HEADING,
  CURRENT_STATE_HEADING,
  isCompactionMemoryMessage,
  ISSUES_HEADING,
  PAST_WORK_HEADING,
  RECENT_PROMPTS_HEADING,
  RELEVANT_FILES_HEADING,
  USER_INSTRUCTIONS_HEADING,
  WORK_DONE_HEADING,
} from "./memory-sections.js";

export type CompactionPurpose = "default" | "plan-implement";

export interface CompactionSituation {
  readonly turnInProgress: boolean;
  readonly hasPriorMemory: boolean;
  readonly promptAnchors: string;
  readonly instructionAnchors: string;
}

export type CompactionSource =
  | { readonly kind: "conversation" }
  | { readonly kind: "transcript"; readonly text: string }
  | { readonly kind: "regions"; readonly regions: readonly string[] };

export interface CompactionPromptInput {
  readonly source: CompactionSource;
  readonly situation?: CompactionSituation | undefined;
  readonly durableState?: string | undefined;
  readonly purpose?: CompactionPurpose | undefined;
  readonly partialSource?: boolean | undefined;
}

export const COMPACTION_SYSTEM_PROMPT = [
  "You write continuation memory for an autonomous coding and security agent whose conversation is being compacted.",
  "Follow the format in the user message exactly. You are summarizing the session, not continuing it: never answer the user, call tools, continue the task, or invent findings, file contents, receipts, exit codes or completions.",
].join("\n");

export function compactionSituation(
  messages: readonly ChatMessage[],
  options: { readonly turnInProgress?: boolean | undefined } = {},
): CompactionSituation {
  return {
    turnInProgress: options.turnInProgress ?? !hasCompletedConversationTurn(messages),
    hasPriorMemory: messages.some((message) => message.compaction !== undefined || isCompactionMemoryMessage(message)),
    promptAnchors: compactionPromptAnchors(messages),
    instructionAnchors: inheritedInstructionAnchors(messages),
  };
}

const ROLE = [
  "CONTEXT COMPACTION",
  "",
  "Pause the task for this one response. The conversation has reached its context limit and is about to be replaced by the continuation memory you write now. Afterwards the agent continues with only the system prompt, this memory, re-injected session state (active plan, durable envelope, project instructions, skills) and the most recent messages. Anything you leave out is gone, so the memory must let the agent resume exactly where it stopped, without repeating finished work, drifting from the user's intent, or forgetting a rule.",
  "",
  "Write the memory only. Do not answer the user, call tools, continue the work, or invent results, file contents, receipts, exit codes or completions. Use your own words.",
];

const PLAN_HANDOFF = [
  "",
  "PURPOSE: the user accepted the plan built in plan mode and the agent now implements it. The active goal is to execute that accepted plan; the plan itself is re-injected separately, so reference its tasks instead of copying them. Context gathered carries the plan-mode research evidence (for security work: targets, scope, confirmed findings, negative results and untested areas). Plan-mode restrictions such as gather-only or wait-for-approval are historical now, while engagement scope and safety rules still apply.",
];

function situationLines(input: CompactionPromptInput): string[] {
  const { situation, source } = input;
  if (!situation) return [];
  const lines = ["", "SITUATION"];
  if (input.partialSource) {
    lines.push("- The source covers only the older part of the session; the newer turns stay in the live history right after this memory. Summarize the source completely and do not guess about the newer turns.");
  }
  lines.push(situation.turnInProgress
    ? "- The agent was in the middle of the latest user request when the limit was hit. The latest user message is kept verbatim after the memory; the memory must say precisely what was in progress and what comes next."
    : "- The latest turn ended with a final answer. Unless the conversation shows unfinished commitments, the latest task is complete.");
  if (situation.hasPriorMemory) {
    lines.push("- An earlier compaction memory appears in the source. It is the only record of everything before it: carry every still-relevant fact forward, merged with the newer turns and rewritten into the sections below. Move tasks that have since finished into Past completed work; never drop earlier completed work.");
  }
  if (source.kind === "regions") {
    lines.push("- The source is a set of chronological region notes of one session; merge them into one memory and let later regions override earlier ones.");
  }
  if (situation.promptAnchors) lines.push("", situation.promptAnchors);
  if (situation.instructionAnchors) lines.push("", situation.instructionAnchors);
  return lines;
}

const FORMAT = [
  "",
  "FORMAT: write these sections in this exact order with these exact headings. Every section is required except Issues and risks, which you omit entirely when there is no genuine issue.",
  "",
  ACTIVE_GOAL_HEADING,
  "The one goal the agent pursues next, as a precise, self-contained brief. Build it from the latest unfinished user task combined with every later follow-up, correction and piece of feedback; when the user changed direction mid-task, state the new direction and what it replaces. Include the definition of done (acceptance criteria and required verification such as tests, build, commit or push) and any scope limits or non-goals the user or the work established. If every task is finished, write \"No active task.\", name what was completed last, and say the agent should wait for the next request. Older finished tasks do not belong here.",
  "",
  USER_INSTRUCTIONS_HEADING,
  "Rules the user gave about how to work, rewritten concisely in your own words while keeping exact values (limits, names, versions, paths, required wording). One bullet each:",
  "- [S1] (session) a rule for all work in this session or project, such as code style, \"write like a senior developer\", \"no file over 300 lines\", git and commit rules, tools to use or avoid.",
  "- [T1] (task: short task name) a rule that applies only within one task, such as \"while changing the UI, do not increase the composer width\".",
  "Requests to do something (\"fix this UI\", \"change the color\", \"add /creds\") are tasks, not instructions; they belong in Active goal, Work done or Past completed work. Reuse carried IDs and give new rules the next free S or T number. Session rules last for the whole session. Keep a task rule only while its task is active or unfinished, and drop it once that task is done or abandoned. When the user changes or revokes a session rule, write \"- [S1] (retired) user: \\\"exact newer user quote\\\"\" and add the replacement as a new bullet. Rules from project instruction files (AGENTS.md, .clai/INSTRUCTIONS.md and similar) are re-injected separately, so do not copy them here, and never persist session or task rules into those files. Write \"None\" when there are no rules. Never write secret values.",
  "",
  CONTEXT_GATHERED_HEADING,
  "Everything learned that the active goal depends on, so the agent never has to rediscover it: what exists and where (paths with line numbers, symbols, functions, components, config keys, endpoints, data shapes), how the relevant code or system works, why the problem happens (root cause and evidence), environment facts (stack, package manager, working commands, versions), constraints, decisions the user made or the work applied with their reasons (an approach nobody has chosen or applied yet is not a decision: put it in next steps as a proposal), and findings from tools, web research and subagents. For non-coding work, record each relevant command or tool finding with its key result. Quote code only where the exact text matters, such as a signature or an error message.",
  "",
  WORK_DONE_HEADING,
  "Everything already done toward the active goal: each change as `path:line` or symbol, what changed (before → after) and why; files created or deleted; commands run with a short result (test counts, build status, commit hashes, pushes). Mark clearly what was applied and verified versus attempted, failed, reverted or only partly applied. Write \"Nothing yet.\" when no work has started.",
  "",
  CURRENT_STATE_HEADING,
  "The most important section: it decides whether the agent resumes correctly. State exactly where the work stopped: what was in progress at the moment of compaction (the step, file or command, and what had and had not been applied), the workspace state (uncommitted changes, branch, running processes, background jobs, subagents and whether their results were read) and the latest user follow-up the agent must honor. Then give a numbered list of concrete next actions, starting with the very next one, each with how to verify it. Never list completed work as a next step, never re-plan finished steps, and never invent new tasks. When nothing remains, say so.",
  "",
  PAST_WORK_HEADING,
  "Every earlier task in this session that is finished and is not the active goal, oldest first, one bullet per task: what the user asked, what was done (key files and symbols), the outcome and its verification, and its delivery state (uncommitted, committed with hash, pushed, PR open, merged, or unknown). Merge the entries from any earlier memory and rewrite them as tasks finish. Say when a past task relates to the active goal. Write \"None.\" when the active goal is the first task.",
  "",
  RELEVANT_FILES_HEADING,
  "Files the agent needs for the active goal, most important first, as `path:line-range` — symbol and why it matters. At most about 20 entries; never list every file that was read.",
  "",
  ISSUES_HEADING,
  "Only genuine open problems: failing tests, unresolved errors, blockers, risky partial edits, conflicting requirements, decisions the user must make. Omit the whole section when there are none.",
  "",
  `Do not write a "${RECENT_PROMPTS_HEADING.replace(/^## /, "")}" section; the application appends the verbatim prompts.`,
];

const QUALITY = [
  "",
  "QUALITY",
  "- Be concrete and complete. Prefer exact identifiers, paths, line numbers, commands, values and error text over paraphrase; vague phrases such as \"updated the logic\" are useless to the next agent.",
  "- Read the source to the very end: the latest tool call, result and user message define the current state. Decisions that were replaced or reverted are superseded; record only the final choice and why.",
  "- Separate fact from intent: a decision, scope limit or design counts as made only when the user stated it or the work applied it. Your own suggestions for how to proceed belong in Current state and next steps, phrased as proposed steps.",
  "- State each fact once, in the section where the next agent will look for it.",
  "- Delegated workers are subagents: record each one's id and attempt, task, status, whether its result was read, and the conclusions of results already read; retained reports stay recoverable by id and attempt. Keep background jobs and Responder tasks separate from subagents. The RESPONDER RESULT LEDGER is authoritative: never describe a consumed=true result as unread, and keep unread results pending.",
  "- Approval and mode gates: plan-mode gather-only or wait-for-approval limits end only when the user accepts the plan; research-only or no-implementation limits the user set for the current topic stay in force. Compaction never grants approval, and an answered question never authorizes new work.",
  "- Refer to credentials and secrets by purpose only; their values are carried separately.",
  "- Length: as long as needed to lose nothing that matters and no longer, usually 1,500 to 4,000 tokens and up to about 6,000 for long sessions with several tasks. Plain Markdown with bullets, no code fences around the whole memory. Finish every section and end on a complete sentence.",
];

function sourceLines(source: CompactionSource): string[] {
  switch (source.kind) {
    case "conversation":
      return ["", "SOURCE: the entire conversation above this message, up to and including the most recent turn. This message itself is not part of the session."];
    case "transcript":
      return ["", "SOURCE (session transcript, oldest first):", "", source.text];
    case "regions":
      return ["", "SOURCE (region notes, oldest first):", "", source.regions.map((region, index) => `REGION ${index + 1}:\n${region}`).join("\n\n")];
  }
}

export function buildCompactionUserPrompt(input: CompactionPromptInput): string {
  const durable = input.durableState?.trim();
  return [
    ...ROLE,
    ...(input.purpose === "plan-implement" ? PLAN_HANDOFF : []),
    ...situationLines(input),
    ...(durable ? ["", "DURABLE STATE (authoritative for plan, task, job and result statuses):", durable] : []),
    ...FORMAT,
    ...QUALITY,
    ...sourceLines(input.source),
  ].join("\n");
}

export function buildDirectCompactionPrompt(input: {
  readonly messages: readonly ChatMessage[];
  readonly durableState?: string | undefined;
  readonly purpose?: CompactionPurpose | undefined;
  readonly turnInProgress?: boolean | undefined;
}): string {
  return buildCompactionUserPrompt({
    source: { kind: "conversation" },
    situation: compactionSituation(input.messages, { turnInProgress: input.turnInProgress }),
    durableState: input.durableState,
    purpose: input.purpose,
  });
}

export function buildCompactionChunkPrompt(input: {
  readonly chunk: string;
  readonly index: number;
  readonly total: number;
  readonly purpose?: CompactionPurpose | undefined;
}): string {
  return [
    `REGION NOTES ${input.index + 1} OF ${input.total}`,
    "",
    "This is one chronological region of a long session that is being compacted. Write dense notes that a later pass will merge into the final memory. Summarize only what this region shows; do not answer the user, call tools, continue the work or guess about other regions.",
    ...(input.purpose === "plan-implement" ? ["The session is a plan-mode research phase whose accepted plan will be implemented next; keep research evidence, findings, negative results and open areas."] : []),
    "",
    "Use these headings and keep every consequential detail:",
    "### Tasks requested — each user request in order, with every later follow-up or correction, and whether it finished in this region.",
    "### User instructions — each rule about how to work, quoted exactly, marked session-wide or tied to one task; prompts that ask for work are tasks, not instructions.",
    "### Context gathered — paths with line numbers, symbols, mechanisms, root causes, environment facts, decisions with reasons, tool, web and subagent findings.",
    "### Work done — each change as path:line or symbol (before → after), commands with short results, commits and pushes, failed or reverted attempts.",
    "### State at the end of the region — what was in progress, pending next steps, open problems.",
    "",
    "Use exact identifiers. Never copy transcript lines, tool-call syntax or long output, and never write secret values.",
    "",
    "SOURCE (region):",
    "",
    input.chunk,
  ].join("\n");
}

export function buildCompactionReducePrompt(input: {
  readonly partials: readonly string[];
  readonly situation?: CompactionSituation | undefined;
  readonly durableState?: string | undefined;
  readonly purpose?: CompactionPurpose | undefined;
}): string {
  return buildCompactionUserPrompt({
    source: { kind: "regions", regions: input.partials },
    situation: input.situation,
    durableState: input.durableState,
    purpose: input.purpose,
  });
}

export type CompactionRetryReason = "truncated" | "incomplete" | "reasoning-only" | "replayed";

const RETRY_ISSUES: Record<CompactionRetryReason, string> = {
  truncated: "The previous draft hit its output limit.",
  "reasoning-only": "The previous draft contained no visible memory.",
  replayed: "The previous draft copied transcript lines or tool-call syntax.",
  incomplete: "The previous draft ended abruptly or missed required sections.",
};

export function buildCompactionRetryPrompt(prompt: string, reason: CompactionRetryReason): string {
  return `${prompt}\n\nQUALITY RETRY: ${RETRY_ISSUES[reason]} Write the complete memory again from the source, not as a continuation of the failed draft. Use every required section, keep every consequential fact once, and end on a complete sentence.`;
}
