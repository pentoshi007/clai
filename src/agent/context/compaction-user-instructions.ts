import { isInternalChatMessage, type ChatMessage, type CompactedUserInstruction } from "../../types.js";
import { redactSecrets } from "../../llm/provider.js";
import {
  ACTIVE_GOAL_HEADING,
  replaceSections,
  insertSectionAfter,
  sectionRanges,
  USER_INSTRUCTIONS_HEADING,
} from "../compaction/memory-sections.js";
import { redactUserCredentialsFromMemory } from "./user-credentials.js";

export { USER_INSTRUCTIONS_HEADING };

const EMPTY_SECTION = /^(?:none|n\/a|no (?:\w+\s+){0,3}instructions?(?:\s+\w+){0,3})[.!]?$/i;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/;
const ENTRY = /^(?:\[([A-Za-z]\d+)\]\s*)?(?:\((session|retired|task(?:\s*:\s*([^)]*))?|turn)\)\s*)?(.+)$/i;
const RETIREMENT = /^user:\s*"((?:[^"\\]|\\.)+)"/i;

interface ParsedEntry {
  readonly id?: string | undefined;
  readonly retired: boolean;
  readonly quote?: string | undefined;
  readonly instruction?: Omit<CompactedUserInstruction, "id"> | undefined;
}

function clean(text: string): string {
  return redactSecrets(redactUserCredentialsFromMemory(text)).replace(/\s+/g, " ").trim();
}

function normalized(text: string): string {
  return clean(text).toLowerCase().replace(/[.!;\s]+$/, "");
}

function bullets(body: string): string[] {
  const entries: string[] = [];
  for (const line of body.split("\n")) {
    const bullet = BULLET.exec(line);
    if (bullet) entries.push(bullet[1]!.trim());
    else if (line.trim() && entries.length > 0) entries[entries.length - 1] += ` ${line.trim()}`;
  }
  return entries;
}

function unescapeQuote(quote: string): string | undefined {
  try {
    const value: unknown = JSON.parse(`"${quote}"`);
    return typeof value === "string" ? clean(value) || undefined : undefined;
  } catch {
    return undefined;
  }
}

function parseEntry(raw: string): ParsedEntry | undefined {
  if (EMPTY_SECTION.test(raw.trim())) return undefined;
  const match = ENTRY.exec(raw.trim());
  if (!match) return undefined;
  const id = match[1]?.toUpperCase();
  const scope = match[2]?.toLowerCase();
  const text = clean(match[4]!);
  if (!text) return undefined;
  if (scope === "retired") {
    const quote = RETIREMENT.exec(text)?.[1];
    const unquoted = quote ? unescapeQuote(quote) : undefined;
    return { id, retired: true, ...(unquoted ? { quote: unquoted } : {}) };
  }
  const task = clean(match[3] ?? "");
  const taskScoped = scope?.startsWith("task") === true || scope === "turn";
  return {
    id,
    retired: false,
    instruction: taskScoped
      ? { scope: "task", ...(task ? { task } : {}), text }
      : { scope: "session", text },
  };
}

function parseSection(summary: string): ParsedEntry[] {
  return sectionRanges(summary, USER_INSTRUCTIONS_HEADING)
    .flatMap(({ body }) => bullets(body))
    .map(parseEntry)
    .filter((entry): entry is ParsedEntry => entry !== undefined);
}

function fromStored(instruction: CompactedUserInstruction | { id: string; scope: string; text: string; task?: string }): CompactedUserInstruction {
  const task = instruction.scope !== "session";
  return {
    id: instruction.id.toUpperCase(),
    scope: task ? "task" : "session",
    ...(task && instruction.task ? { task: clean(instruction.task) } : {}),
    text: clean(instruction.text),
  };
}

function latestMemoryIndex(messages: readonly ChatMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "system" && message.compaction) return index;
  }
  return -1;
}

export function carriedUserInstructions(messages: readonly ChatMessage[]): readonly CompactedUserInstruction[] {
  const index = latestMemoryIndex(messages);
  if (index < 0) return [];
  const memory = messages[index]!;
  if (memory.compaction?.userInstructions) return memory.compaction.userInstructions.map(fromStored);
  let next = 1;
  return parseSection(memory.content).flatMap((entry) =>
    entry.instruction ? [{ id: entry.id ?? `S${next++}`, ...entry.instruction }] : []);
}

function renderEntry(instruction: CompactedUserInstruction): string {
  const scope = instruction.scope === "session"
    ? "session"
    : instruction.task ? `task: ${instruction.task}` : "task";
  return `- [${instruction.id}] (${scope}) ${instruction.text}`;
}

export function withoutUserInstructionSection(text: string): string {
  return replaceSections(text, USER_INSTRUCTIONS_HEADING, "");
}

export function renderUserInstructions(instructions: readonly CompactedUserInstruction[]): string {
  return instructions.length > 0 ? [USER_INSTRUCTIONS_HEADING, ...instructions.map(renderEntry)].join("\n") : "";
}

export function inheritedInstructionAnchors(messages: readonly ChatMessage[]): string {
  const inherited = carriedUserInstructions(messages);
  if (inherited.length === 0) return "";
  return [
    "INSTRUCTIONS CARRIED FROM THE PREVIOUS MEMORY (reuse these IDs; session rules are kept automatically unless you retire them with a newer user quote; task rules survive only if you rewrite them):",
    ...inherited.map(renderEntry),
  ].join("\n");
}

function userMessagesSinceMemory(messages: readonly ChatMessage[]): string[] {
  return messages
    .slice(latestMemoryIndex(messages) + 1)
    .filter((message) => message.role === "user" && !isInternalChatMessage(message))
    .map((message) => clean(message.content));
}

class InstructionIds {
  private readonly used = new Set<string>();

  reserve(id: string): void {
    this.used.add(id);
  }

  claim(preferred: string | undefined, scope: CompactedUserInstruction["scope"]): string {
    if (preferred && !this.used.has(preferred)) {
      this.used.add(preferred);
      return preferred;
    }
    const prefix = scope === "session" ? "S" : "T";
    let next = 1;
    while (this.used.has(`${prefix}${next}`)) next += 1;
    const id = `${prefix}${next}`;
    this.used.add(id);
    return id;
  }
}

export function reconcileCompactionUserInstructions(summary: string, messages: readonly ChatMessage[]): {
  summary: string;
  instructions: readonly CompactedUserInstruction[];
} {
  const inherited = carriedUserInstructions(messages);
  const entries = parseSection(summary);
  const newerUserText = userMessagesSinceMemory(messages);
  const retired = new Set(
    entries
      .filter((entry) => entry.retired && entry.id && entry.quote && newerUserText.some((text) => text.includes(entry.quote!)))
      .map((entry) => entry.id!),
  );
  const proposedById = new Map<string, Omit<CompactedUserInstruction, "id">>();
  for (const entry of entries) {
    if (entry.id && entry.instruction && !proposedById.has(entry.id)) proposedById.set(entry.id, entry.instruction);
  }
  const inheritedIds = new Set(inherited.map(({ id }) => id));
  const ids = new InstructionIds();
  for (const id of inheritedIds) ids.reserve(id);
  const kept: CompactedUserInstruction[] = [];
  for (const instruction of inherited) {
    if (retired.has(instruction.id)) continue;
    const proposed = proposedById.get(instruction.id);
    if (proposed) kept.push({ ...instruction, text: proposed.text });
    else if (instruction.scope === "session") kept.push(instruction);
  }
  for (const entry of entries) {
    if (!entry.instruction || (entry.id && inheritedIds.has(entry.id))) continue;
    kept.push({ id: ids.claim(entry.id, entry.instruction.scope), ...entry.instruction });
  }
  const seen = new Set<string>();
  const instructions = kept.filter((instruction) => {
    const key = normalized(instruction.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rendered = renderUserInstructions(instructions);
  const hasSection = sectionRanges(summary, USER_INSTRUCTIONS_HEADING).length > 0;
  const next = hasSection
    ? replaceSections(summary, USER_INSTRUCTIONS_HEADING, rendered)
    : rendered
      ? insertSectionAfter(summary, [ACTIVE_GOAL_HEADING], rendered)
      : summary.trim();
  return { summary: next, instructions };
}
