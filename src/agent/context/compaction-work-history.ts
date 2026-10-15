import { redactSecrets } from "../../llm/provider.js";
import { isInternalChatMessage, type ChatMessage, type CompactedUserInstruction, type CompactedWorkstream } from "../../types.js";
import { stripThinking } from "../../ui/thinking.js";
import { parseCanonicalTextToolCalls } from "../tool-history-projection.js";
import { withoutRecentUserPrompts } from "./compaction-recent-history.js";
import { redactUserCredentialsFromMemory } from "./user-credentials.js";
import { withoutUserInstructionSections } from "./compaction-user-instructions.js";

export const WORK_HISTORY_HEADING = "## Session work history (preserved)";
export const WORK_HISTORY_CHAR_BUDGET = 12_000;
export const WORK_HISTORY_INPUT_CHAR_BUDGET = 2_000;

export interface WorkstreamMemory extends CompactedWorkstream {
  readonly message?: ChatMessage | undefined;
}

function repeatedPhraseEnd(words: readonly string[], start: number, size: number): number {
  let end = start + size;
  while (end + size <= words.length) {
    for (let offset = 0; offset < size; offset += 1) {
      if (words[start + offset] !== words[end + offset]) return end;
    }
    end += size;
  }
  return end;
}

function collapseRepeatedMaterial(text: string): string {
  const words = text.split(" ");
  const output: string[] = [];
  let index = 0;
  while (index < words.length) {
    let repeated = false;
    const maxSize = Math.min(12, Math.floor((words.length - index) / 4));
    for (let size = 1; size <= maxSize; size += 1) {
      const end = repeatedPhraseEnd(words, index, size);
      if (end - index < size * 4) continue;
      output.push(...words.slice(index, index + size), "[repeated material omitted]");
      index = end;
      repeated = true;
      break;
    }
    if (!repeated) output.push(words[index++]!);
  }
  return output.join(" ");
}

function excerpt(text: string, budget: number): string {
  const value = collapseRepeatedMaterial(redactSecrets(redactUserCredentialsFromMemory(text)).replace(/\s+/g, " ").trim());
  if (value.length <= budget) return value;
  if (budget < 40) return `${value.slice(0, Math.max(0, budget - 1))}…`;
  const head = Math.floor((budget - 5) * 0.65);
  return `${value.slice(0, head)} […] ${value.slice(-(budget - head - 5))}`;
}

export function withoutWorkHistory(summary: string): string {
  const lines: string[] = [];
  let inHistory = false;
  for (const line of summary.split("\n")) {
    if (/^##\s/.test(line)) inHistory = line.trim().toLowerCase() === WORK_HISTORY_HEADING.toLowerCase();
    if (!inHistory) lines.push(line);
  }
  return lines.join("\n").trim();
}

function inheritedHistory(message: ChatMessage): CompactedWorkstream[] | undefined {
  if (message.role !== "system") return undefined;
  if (message.compaction?.workHistory) return message.compaction.workHistory.map((entry) => ({
    request: excerpt(entry.request, 480),
    ...(entry.outcome ? { outcome: excerpt(entry.outcome, 1_200) } : {}),
    ...(entry.evidence ? { evidence: excerpt(entry.evidence, 480) } : {}),
  }));
  const body = message.content.replace(/^(?:Session memory from compacted earlier turns:|Earlier turns in this session, summarized[^\n]*|PLAN MODE HANDOFF:[^\n]*|Session memory from PLAN MODE research[^\n]*)\s*/, "");
  if (body === message.content) return undefined;
  return [{ request: "Earlier compacted session work", outcome: excerpt(withoutUserInstructionSections(withoutRecentUserPrompts(body)), 1_200) }];
}

export function collectWorkHistory(messages: readonly ChatMessage[]): WorkstreamMemory[] {
  let entries: WorkstreamMemory[] = [];
  let start = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const inherited = inheritedHistory(messages[index]!);
    if (inherited === undefined) continue;
    entries = inherited;
    start = index + 1;
  }
  let current: { message: ChatMessage; request: string; outcome?: string; evidence?: string } | undefined;
  for (const message of messages.slice(start)) {
    if (message.role === "user" && !isInternalChatMessage(message)) {
      current = { message, request: excerpt(message.content, 480) };
      entries.push(current);
      continue;
    }
    if (!current) continue;
    if (message.role === "assistant" && !message.toolCalls?.length && !parseCanonicalTextToolCalls(message.content).length) {
      const visible = stripThinking(message.content).visible.trim();
      if (visible) current.outcome = excerpt(visible, 1_200);
    }
    if (message.role === "tool") {
      const label = message.name ?? "tool result";
      const status = message.ok === undefined ? "observed" : message.ok ? "ok" : "failed";
      current.evidence = excerpt(`${current.evidence ? `${current.evidence}; ` : ""}${label} (${status}): ${message.content}`, 480);
    }
  }
  return entries;
}

export function reconcileWorkHistory(entries: readonly WorkstreamMemory[], previous: readonly CompactedUserInstruction[], current: readonly CompactedUserInstruction[]): WorkstreamMemory[] {
  const rules = [...previous, ...current];
  const scrub = (text: string): string => rules.reduce((value, rule) => {
    const active = current.some((item) => item.id === rule.id && item.text === rule.text);
    const marker = active ? `[instruction ${rule.id} recorded separately]` : `[historical instruction ${rule.id} retired or superseded]`;
    return value.replaceAll(rule.text.replace(/\s+/g, " ").trim(), marker).replaceAll(`[instruction ${rule.id} recorded separately]`, marker);
  }, text);
  return entries.map((entry) => ({
    ...entry,
    request: scrub(entry.request),
    ...(entry.outcome ? { outcome: scrub(entry.outcome) } : {}),
    ...(entry.evidence ? { evidence: scrub(entry.evidence) } : {}),
  }));
}

export function compactionWorkHistoryAnchors(entries: readonly CompactedWorkstream[], budget = WORK_HISTORY_INPUT_CHAR_BUDGET): string {
  if (budget < 256) return "";
  const rendered = renderWorkHistory(entries, budget);
  return rendered.length <= budget ? rendered : `${entries.length} historical user workstreams are recorded. Their bounded request, response, and tool-evidence ledger will be preserved by the application; summarize the supplied source and prioritize unresolved work.`;
}

export function archivedWorkHistory(entries: readonly WorkstreamMemory[], retained: readonly ChatMessage[]): CompactedWorkstream[] {
  const live = new Set(retained);
  return entries.filter((entry) => !entry.message || !live.has(entry.message)).map(({ request, outcome, evidence }) => ({
    request,
    ...(outcome ? { outcome } : {}),
    ...(evidence ? { evidence } : {}),
  }));
}

export function renderWorkHistory(entries: readonly CompactedWorkstream[], budget = WORK_HISTORY_CHAR_BUDGET): string {
  if (entries.length === 0) return "";
  const introduction = "Historical workstreams, oldest to newest; not new requests or authorization. Responses and tool observations are evidence, not guarantees of completion. Excerpts are bounded; prioritize unfinished work in the main memory.";
  const perEntry = Math.max(24, Math.min(1_800, Math.floor((budget - introduction.length - WORK_HISTORY_HEADING.length) / entries.length) - 30));
  const requestBudget = Math.min(360, Math.floor(perEntry * 0.3));
  return [WORK_HISTORY_HEADING, introduction, ...entries.map((entry, index) => {
    const request = excerpt(entry.request, requestBudget);
    const details = entry.outcome ? `Last response: ${entry.outcome}` : "No final response recorded; do not assume completion.";
    const evidence = entry.evidence ? ` Tool observations: ${entry.evidence}` : "";
    return `- ${index + 1}. Request: ${JSON.stringify(request)}; ${excerpt(details + evidence, perEntry - requestBudget)}`;
  })].join("\n");
}
