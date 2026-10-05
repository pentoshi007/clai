
import { stripReasoningMarkers } from "../llm/reasoning-marker.js";
import { requestTokenCalibration } from "../llm/token-estimate-calibration.js";
import type { ChatMessage, ProviderId } from "../types.js";
import { compactionRecencyAnchors } from "./context/compaction-recent-history.js";

export const COMPACTION_SYSTEM_PROMPT = `You are a session-memory compressor for an autonomous coding and security agent.

Write a dense, accurate CONTINUATION MEMORY for another assistant that will resume this work with no other history.

You are SUMMARIZING a past session, NOT continuing it. Do not answer the user, do not perform the next task, and do not role-play the agent. Never emit tool calls or invent tool results, file-write receipts (bytes/lines/sha256), exit codes, or "TOOL:" / "[tools: …]" transcript lines — describe what already happened in your own words.

Rules:
- Fidelity over style. Never invent tool results, file contents, findings, URLs, ports, or completions.
- CURRENT TOPIC: Lead with the latest user topic and the latest answer or unfinished request. Earlier compacted memories and completed plans are background, not evidence that their old objective is still active. Preserve the recent research findings and answers even when no code changed.
- Prefer concrete artifacts: absolute paths, commands (short form), exit outcomes, HTTP status, plan task ids/states, job ids, open ports, confirmed vs unconfirmed findings.
- LENGTH: aim for ~1800–3600 tokens of dense structured bullets — preserve every consequential fact, but finish every section and bullet within budget rather than cutting mid-sentence. Prefer one precise mention over repeated coverage.
- DETAIL LEVEL: mechanism-level specificity. For code changes name the file path with line anchors, what changed, the before→after behavior, and the verification evidence (which tests/typecheck/build status prove it). For debugging name the root cause, each failed approach, and why it failed. For research name exact findings with their evidence. For pending work give the next concrete step a cold reader can execute immediately. A reader resuming with no other context must not need to re-discover anything recorded below.
- NO DUPLICATION: state each fact exactly once, in its best section. This memory is prepended to a live context that ALSO re-injects fresh ACTIVE PLAN, SESSION STATE, and ENGAGEMENT SCOPE — do not restate the full plan or every task, and do not reproduce long user prompts verbatim; capture goals/deltas concisely.
- Never copy secrets (API keys, passwords, tokens, private keys) into the memory. Credentials the user supplied are carried verbatim in the DURABLE WORK ENVELOPE, so refer to them by purpose only (for example "the user-supplied Stripe test key").
- Omit progress bars, repeated failures, and decorative chatter — but list genuinely informative failures (with cause and attempt count) under Open risks / failures.
- Do not wrap the whole answer in markdown code fences.
- If something is unknown, write "(unknown)" rather than guessing.
- PHASE AWARENESS: Temporary UI/mode gates (plan-mode gather-only, "await accept", "do not implement yet") are HISTORICAL context — never rewrite them as permanent forever-rules for the resuming agent. Durable user/engagement policy (scope, non-destructive default, stay on remote target when that is the engagement) may still apply.`;

export interface CompactionPromptParts {
  visualTranscript?: string | undefined;
  messageTranscript: string;
  durableState?: string | undefined;
  purpose?: "default" | "plan-implement" | undefined;
  recencyAnchors?: string | undefined;
}

export function buildCompactionUserPrompt(parts: CompactionPromptParts): string {
  const visual = parts.visualTranscript?.trim() ?? "";
  const fromMessages = parts.messageTranscript.trim();
  const durable = parts.durableState?.trim() ?? "";
  const planImplement = parts.purpose === "plan-implement";

  let transcript = "";
  if (visual && fromMessages) {
    transcript = `${visual}\n\n---\n\nOLDER MODEL TURNS:\n\n${fromMessages}`;
  } else {
    transcript = visual || fromMessages;
  }

  const sections: string[] = [];

  if (planImplement) {
    sections.push(
      "Create a complete but compact HANDOFF MEMORY from PLAN-MODE RESEARCH for an agent that will EXECUTE the accepted plan next.",
      "Do not add another framing paragraph; the memory wrapper already labels this as PLAN MODE HANDOFF and ACTIVE PLAN is re-injected separately.",
      "The material below was gathered under plan mode to design that plan/tasks. The next phase is agent implement — not gather-only.",
      "The live ACTIVE PLAN (goal/detail/tasks) will be re-injected separately — your job is ACTIONABLE research memory so implement does not re-discover or miss coverage.",
      "",
      "Use these section headings as applicable. For coding/general work, omit empty security-only sections instead of writing repeated `none` bullets; for pentest handoffs retain the coverage/finding sections:",
      "## User goals",
      "## Research evidence (facts from plan-mode tools)",
      "## Coverage ledger (do not blindly re-do)",
      "## Confirmed findings",
      "## Negative / tested-OK results",
      "## Untested / open classes",
      "## Artifacts & paths",
      "## Durable engagement rules (still apply in agent mode)",
      "## Plan-mode-only notes (historical — not current agent gates)",
      "## Commands/tools and key results",
      "## Current state",
      "## Remaining work (post-accept tasks)",
      "## Open risks / failures",
      "",
      "How to fill sections (agent-performance critical):",
      "- DEDUPLICATE: state each fact once in the best section. Do not repeat destination/tool versions/config contents under evidence, findings, commands, and current state.",
      "- For coding handoffs, target ~600–1000 tokens. Security handoffs may use the full 800–1500 only when needed to preserve findings/coverage.",
      "- Research evidence: concrete verified facts only — project state/stack/config for coding; hosts/IPs, ports, stack fingerprint, auth surfaces, headers, endpoints, versions for security. Complete every bullet.",
      "- Coverage ledger: expensive/stable research already done so execution deepens rather than restarts. This does NOT forbid one concise revalidation of mutable workspace/manifest/tool state after handoff.",
      "- Confirmed findings: each as severity + one-line evidence + impact/repro if known (F1, F2, … or short titles). If none yet, say so.",
      "- Negative / tested-OK: things checked and not issues (SSRF guard, CORS locked, etc.) so implement does not re-burn steps.",
      "- Untested / open classes: authz/IDOR, RBAC, payment, injection, etc. still open — especially anything blocked on credentials.",
      "- Artifacts & paths: include only reusable artifacts the implementer may need (reports, downloads, extracted specs, scan outputs). Omit routine local inspection receipt paths and transient temp logs whose result is already summarized.",
      "- Durable engagement rules ONLY if they still bind implement (remote target/scope, authorized testing, non-destructive default, do not treat clai workspace as the target, no local dev server for remote assessments).",
      "- Plan-mode-only notes: gather-only / await-accept / no-exploit-yet gates that applied BEFORE accept — label historical; implementer is past that phase.",
      "- Delegated work: keep every subagent, background job, and Responder task id with its title; fold the conclusions of results already read into Research evidence or Confirmed findings. Results not yet read are re-delivered after resume — list them as pending, never as read.",
      "- Commands/tools: only non-obvious or reusable commands and their outcomes. Do not repeat routine list/read/tool-version facts already captured above.",
      "- Current state: describe the last tool-observed state at compaction time. Do not claim plan acceptance/approval unless DURABLE STATE confirms it; distinguish transition assumptions from evidence.",
      "- Remaining work: ACTIVE PLAN is injected separately, so do not restate every task. Record only the next task, dependency/order caveats, blockers, or plan details not present in durable state.",
      "- Resolve contradictions explicitly (for example, a non-empty destination is not simultaneously guaranteed safe for an in-place scaffolder). If evidence conflicts, preserve the uncertainty and safest next check.",
      "- Do NOT invent findings. Do NOT omit confirmed issues that appear in the material. Prefer denser bullets over long prose.",
      "- Prefer COMPLETE short memory over a long memory that cuts off mid-sentence.",
    );
  } else {
    sections.push(
      "Create a complete but compact continuation memory. Treat resumed history and newer turns as one continuous session. Summarize; never answer the user, continue work, invent results, or emit tool calls/transcript receipts.",
      "Open with a single ORIENTATION line about the LATEST user topic and its status (answered / in progress / blocked). Derive it from the newest conversation, not the goal of an older completed plan or prior compacted memory.",
      "For research-only or explanatory questions, preserve the actual answers, findings, code paths, evidence, and caveats. An answered question does not authorize implementation or resuming unrelated fixes.",
      "Earlier compacted memories are historical, fallible summaries. Resolve their claims against newer messages and verified state; never promote a speculative interpretation of an old approval into a current task.",
      "",
      "Organize under these exact section headings (skip a section only if empty):",
      "## Latest conversation",
      "## User goals",
      "## Key facts and environment",
      "## Decisions and constraints",
      "## Work completed",
      "## In flight / blocked",
      "## Commands/tools and results",
      "## Current state",
      "## Remaining work",
      "## Relevant files",
      "## Open risks / failures",
      "",
      "Write for a reader with zero prior context:",
      "- Latest conversation: prioritize the last three user topics, the answers/findings/changes for each, evidence, caveats, decisions, and unresolved questions. Research conclusions matter even when no files changed.",
      "- Goals/constraints: preserve user intent, hard limits, requested execution boundary, referenced roadmap/plan/task/index paths, and each decision's rationale and source.",
      "- Facts/completed work: mechanism-level specificity — API/data shapes, parser/gate behavior, environment/stack/package manager, file paths and line anchors, before→after behavior, and verification commands/results (or 'not yet verified'). Keep reusable artifacts and user-supplied nonsecret values.",
      "- In flight/remaining: confirmed unfinished commitments, blockers, next concrete action and verification. Distinguish unverified edits from unapplied designs and historical failures. Do not infer new implementation from research questions.",
      "- Commands/risks: informative failures, causes, failed approaches and outcomes. Current state: dirty worktree, running servers/jobs, ids/PIDs/ports, and last observed results.",
      "- Delegated work: preserve subagent/job/Responder ids, titles, task/parent ids, statuses, and conclusions of results already read. RESPONDER RESULT LEDGER consumed/analyzed state is authoritative; never describe consumed=true entries as unread or needing another artifact read. Unread results remain pending.",
      "- DEDUPLICATE: each fact once. Compress older completed work to reusable state and evidence. Fresh ACTIVE PLAN, SESSION STATE and ENGAGEMENT SCOPE are re-injected; do not repeat their full plan/tasks or routine inspection receipts.",
      "- Do NOT reproduce long user prompts verbatim; capture goals and hard constraints concisely.",
      "- Do not write a Last 3 user prompts section; the application appends it from the actual user messages after generating the memory.",
      "",
      "PHASE AWARENESS under Decisions and constraints:",
      "- Gather-only / await-accept / no-implement gates are historical after plan acceptance; standing engagement policy and current research-only scope still apply.",
    );
  }

  sections.push(
    "",
    "RECENCY (correctness-critical):",
    "- The material runs to the END of the session, including the most recent tool call and the most recent answer. Read the material to its final line before writing anything.",
    "- Anything the material shows as already done belongs under Work completed / Current state. NEVER list completed work under Remaining work, In flight, or as a next step — a resuming agent will redo it.",
    "- Take the LATEST state of any fact that changed during the session. If an approach was adopted and later reverted, replaced, or abandoned, record the final choice as current and the earlier one as superseded with the reason.",
    "- Remaining work must contain only steps the material shows as genuinely not yet performed. If nothing remains, say so explicitly.",
    "- Distinguish confirmed unfinished work from historical failures and speculative to-dos. Preserve genuine outstanding commitments, but do not invent tasks from an ambiguous old approval or reopen completed work because it dominated the earlier history.",
    "- DURABLE STATE is authoritative for its recorded plan/task/job/result statuses and standing constraints. A completed plan does not determine the current conversation topic, and an older goal does not override newer research-only scope.",
  );

  const target =
    "Be specific over short. Target ~1800–3600 tokens of dense continuation memory (~900–1600 for plan-mode handoffs), using more only when required to preserve verified state. Finish every bullet and section. End on a complete sentence. No secret values, fabricated successes, raw pseudo-tool syntax, or full tool dumps.";
  sections.push(target);

  if (durable) {
    sections.push("", "DURABLE STATE (authoritative for recorded statuses; current topic comes from the latest conversation):", durable);
  }

  sections.push("", "SESSION MATERIAL:", "", transcript);
  if (parts.recencyAnchors) sections.push("", parts.recencyAnchors);
  return sections.join("\n");
}

export function buildDirectCompactionPrompt(input: {
  readonly durableState?: string | undefined;
  readonly purpose?: "default" | "plan-implement" | undefined;
  readonly messages?: readonly ChatMessage[] | undefined;
}): string {
  return buildCompactionUserPrompt({
    messageTranscript:
      "The session material is the entire conversation above this instruction, up to and including the most recent turn. Summarize all of it; do not treat this instruction as session content.",
    ...(input.durableState ? { durableState: input.durableState } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.messages ? { recencyAnchors: compactionRecencyAnchors(input.messages) } : {}),
  });
}

export const COMPACTION_TRANSCRIPT_CHAR_BUDGET = 48_000;

export const COMPACTION_MAX_COMPLETION_TOKENS = 12_288;

export const COMPACTION_INPUT_SAFETY_TOKENS = 4_096;

export function compactionSinglePassInputBudget(
  contextLimitTokens: number,
): number {
  if (!Number.isFinite(contextLimitTokens)) return 0;
  return Math.max(
    0,
    Math.floor(contextLimitTokens) -
      COMPACTION_MAX_COMPLETION_TOKENS -
      COMPACTION_INPUT_SAFETY_TOKENS,
  );
}

export function calibratedCompactionSinglePassInputBudget(
  contextLimitTokens: number,
  provider: ProviderId | undefined,
  model: string | undefined,
): number {
  const nominalInputBudget = compactionSinglePassInputBudget(contextLimitTokens);
  const calibration = requestTokenCalibration(provider, model);
  return calibration && calibration.ratio > 1
    ? Math.floor(nominalInputBudget / calibration.ratio)
    : nominalInputBudget;
}

export const COMPACTION_MAP_MAX_COMPLETION_TOKENS = 16_384;

export const COMPACTION_CHUNK_CHAR_BUDGET = 64_000;

export const MAX_COMPACTION_CHUNKS = 8;

export function chunkTranscriptForCompaction(
  transcript: string,
  chunkChars = COMPACTION_CHUNK_CHAR_BUDGET,
  maxChunks = MAX_COMPACTION_CHUNKS,
): string[] {
  const text = transcript.trim();
  if (!text) return [];
  const size = Math.max(chunkChars, Math.ceil(text.length / maxChunks));
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (chunks.length === maxChunks - 1) {
      chunks.push(text.slice(index));
      break;
    }
    const hardEnd = Math.min(text.length, index + size);
    let end = hardEnd;
    if (hardEnd < text.length) {
      const boundary = text.lastIndexOf("\n\n", hardEnd);
      if (boundary > index + Math.floor(size * 0.5)) end = boundary;
    }
    chunks.push(text.slice(index, end));
    index = end;
  }
  return chunks.map((chunk) => chunk.trim()).filter((chunk) => chunk.length > 0);
}

export function buildCompactionChunkPrompt(input: {
  readonly chunk: string;
  readonly index: number;
  readonly total: number;
  readonly purpose?: "default" | "plan-implement" | undefined;
}): string {
  const focus =
    input.purpose === "plan-implement"
      ? "Preserve targets, stack, confirmed findings, negative results, untested classes, artifact paths, commands and remaining work."
      : "Preserve goals, decisions, file paths with line anchors, before→after behavior of each change, verification evidence, environment quirks, commands and their results, task states, failures (with causes), subagent/job/Responder ids with titles and the conclusions of results already read, running jobs and remaining work.";
  return [
    `Summarize region ${input.index + 1} of ${input.total} of one continuous session.`,
    "This is a partial region: do not write an orientation line, do not speculate about regions you cannot see, and do not answer the user.",
    focus,
    "Dense fact bullets only, at mechanism level. Transform the material into findings; never copy transcript lines, headings, tool-call JSON, file-write receipts, or long output verbatim. Preserve completed work, negative results, decisions, paths, commands, blockers, and remaining work so they are not repeated after resume.",
    "",
    "SESSION MATERIAL (REGION):",
    "",
    input.chunk,
  ].join("\n");
}

export function buildCompactionReducePrompt(input: {
  readonly partials: readonly string[];
  readonly durableState?: string | undefined;
  readonly purpose?: "default" | "plan-implement" | undefined;
  readonly recencyAnchors?: string | undefined;
}): string {
  const merged = input.partials
    .map((part, index) => `REGION ${index + 1}:\n${part}`)
    .join("\n\n");
  return buildCompactionUserPrompt({
    messageTranscript: merged,
    ...(input.durableState ? { durableState: input.durableState } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.recencyAnchors ? { recencyAnchors: input.recencyAnchors } : {}),
  });
}

export function trimTranscriptForCompaction(
  transcript: string,
  budget = COMPACTION_TRANSCRIPT_CHAR_BUDGET,
): string {
  if (transcript.length <= budget) return transcript;
  const head = Math.floor(budget * 0.35);
  const tail = budget - head - 80;
  return (
    transcript.slice(0, head) +
    "\n\n[... middle of session omitted for length ...]\n\n" +
    transcript.slice(-tail)
  );
}



export function normalizeCompactionSummary(summary: string): string {
  const seenBullets = new Set<string>();
  const output: string[] = [];
  for (const line of stripReasoningMarkers(summary)
    .replace(/\r\n?/g, "\n")
    .split("\n")) {
    const trimmed = line.trim();
    const bullet = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(trimmed);
    if (bullet) {
      const key = bullet[1]!.replace(/\s+/g, " ").trim().toLowerCase();
      if (seenBullets.has(key)) continue;
      seenBullets.add(key);
    }
    if (!trimmed && output[output.length - 1]?.trim() === "") continue;
    output.push(line.replace(/[ \t]+$/g, ""));
  }
  return output.join("\n").trim();
}

export function looksLikeIncompleteCompactionSummary(summary: string): boolean {
  const text = summary.trim();
  if (!text) return true;
  if ((text.match(/```/g)?.length ?? 0) % 2 !== 0) return true;
  const last = text.split("\n").at(-1)?.trim() ?? "";
  if (/^#{1,6}\s+\S/.test(last)) return true;
  if (/[,;:(\[{=+\-–—]$/.test(last)) return true;
  return /\b(?:and|or|the|a|an|to|with|without|has|have|had|is|are|was|were|from|for|of|in|on|at|by|as|that|which|whose|because|so)$/i.test(last);
}

export function isCompactionCompletionTruncated(
  response: {
    finishReason?: string | undefined;
    usage?: { completionTokens?: number | undefined } | undefined;
  },
  maxTokens: number,
): boolean {
  const finish = response.finishReason?.toLowerCase();
  if (finish === "length") return true;
  if (finish === "stop") return false;
  const used = response.usage?.completionTokens;
  return typeof used === "number" && used >= Math.max(1, maxTokens - 32);
}

export function buildCompactionRetryPrompt(
  prompt: string,
  reason: "truncated" | "incomplete" | "reasoning-only" | "replayed",
): string {
  const issue =
    reason === "truncated"
      ? "The previous draft hit its output limit."
      : reason === "reasoning-only"
        ? "The previous draft contained no visible memory."
        : reason === "replayed"
          ? "The previous draft replayed source transcript or raw pseudo-tool syntax."
          : "The previous draft ended abruptly or was structurally incomplete.";
  return `${prompt}\n\nQUALITY RETRY: ${issue} Rewrite the entire continuation memory from the source, not a continuation of the failed draft. Preserve all consequential facts once, use dense bullets, stay within the requested target, finish every section and bullet, and end on a complete sentence.`;
}

export function looksLikeTranscriptReplay(summary: string): boolean {
  const hardMarkers = [
    /sha256_12\s*=/i,
    /Do NOT re-read this file/i,
    /\(\s*exit\s*=\s*-?\d+\s*,\s*ok\s*=\s*(?:true|false)\s*\)/i,
    /<tool_calls?(?::[^>]+)?>|<arg_key>|<arg_value>|<\/tool_call/i,
    /[\ue000\ue001]/,
    /<\|tool_(?:calls_section|call|call_argument)_(?:begin|end)\|>/i,
    /<[|｜]+tool[_▁](?:calls?[_▁](?:begin|end)|sep)[|｜]+>/i,
    /<[|｜]+DSML[|｜]+(?:tool_calls|invoke|parameter)\b/i,
    /<[|｜]+(?:open|close|sep)[|｜]+>/i,
    /\bbytes\s*=\s*\d+\s+lines\s*=\s*\d+/i,
  ];
  if (hardMarkers.some((re) => re.test(summary))) return true;

  const softMarkers = [
    /^\s*TOOL:\s*Tool\b/im,
    /\[tools:\s/i,
    /\bLet me continue\b/i,
    /\bTask t\d+:/,
  ];
  return softMarkers.filter((re) => re.test(summary)).length >= 2;
}
