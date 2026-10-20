import type { ChatMessage } from "../../types.js";

export const COMPACTION_MEMORY_PREFIX = "Session memory from compacted earlier turns:";

export const PLAN_IMPLEMENT_MEMORY_PREFIX =
  "PLAN MODE HANDOFF: research memory for the accepted implementation phase. Gather-only/await-approval gates are historical; ACTIVE PLAN and SESSION STATE are authoritative:";

export const LEGACY_PLAN_IMPLEMENT_MEMORY_PREFIX =
  "Session memory from PLAN MODE research that was used to build the comprehensive detailed plan and tasks you are seeing now (handoff to agent implement — gather-only phase is over; execute approved tasks):";

export const MECHANICAL_MEMORY_PREFIX = "Earlier turns in this session, summarized";

const MEMORY_PREFIXES = [
  COMPACTION_MEMORY_PREFIX,
  PLAN_IMPLEMENT_MEMORY_PREFIX,
  LEGACY_PLAN_IMPLEMENT_MEMORY_PREFIX,
  MECHANICAL_MEMORY_PREFIX,
] as const;

export function isCompactionMemoryMessage(message: ChatMessage): boolean {
  return message.role === "system" && MEMORY_PREFIXES.some((prefix) => message.content.startsWith(prefix));
}

export const ACTIVE_GOAL_HEADING = "## Active goal";
export const USER_INSTRUCTIONS_HEADING = "## User instructions";
export const CONTEXT_GATHERED_HEADING = "## Context gathered";
export const WORK_DONE_HEADING = "## Work done";
export const CURRENT_STATE_HEADING = "## Current state and next steps";
export const PAST_WORK_HEADING = "## Past completed work";
export const RELEVANT_FILES_HEADING = "## Relevant files";
export const ISSUES_HEADING = "## Issues and risks";
export const RECENT_PROMPTS_HEADING = "## Last 3 user prompts (latest first)";

export const MODEL_MEMORY_HEADINGS = [
  ACTIVE_GOAL_HEADING,
  USER_INSTRUCTIONS_HEADING,
  CONTEXT_GATHERED_HEADING,
  WORK_DONE_HEADING,
  CURRENT_STATE_HEADING,
  PAST_WORK_HEADING,
  RELEVANT_FILES_HEADING,
  ISSUES_HEADING,
] as const;

export interface SectionRange {
  readonly start: number;
  readonly end: number;
  readonly body: string;
}

const SECTION_BOUNDARY = /^#{1,2}\s/;

function normalizedHeading(line: string): string {
  return line.trim().replace(/\s+/g, " ").toLowerCase();
}

export function sectionRanges(text: string, heading: string): SectionRange[] {
  const wanted = normalizedHeading(heading);
  const lines = text.split("\n");
  const ranges: SectionRange[] = [];
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (normalizedHeading(lines[index]!) !== wanted) continue;
    let end = index + 1;
    while (end < lines.length && !SECTION_BOUNDARY.test(lines[end]!.trim())) end += 1;
    ranges.push({
      start: offsets[index]!,
      end: end < lines.length ? offsets[end]! : text.length,
      body: lines.slice(index + 1, end).join("\n").trim(),
    });
  }
  return ranges;
}

export function sectionBody(text: string, heading: string): string | undefined {
  const bodies = sectionRanges(text, heading).map((range) => range.body).filter(Boolean);
  return bodies.length > 0 ? bodies.join("\n") : undefined;
}

export function replaceSections(text: string, heading: string, replacement: string): string {
  const ranges = sectionRanges(text, heading);
  if (ranges.length === 0) return text;
  let result = text;
  for (let index = ranges.length - 1; index >= 0; index -= 1) {
    const range = ranges[index]!;
    const content = index === 0 && replacement ? `${replacement}\n\n` : "";
    result = `${result.slice(0, range.start)}${content}${result.slice(range.end)}`;
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
}

export function withoutSection(text: string, heading: string): string {
  return replaceSections(text, heading, "");
}

export function insertSectionAfter(text: string, previous: readonly string[], section: string): string {
  for (let index = previous.length - 1; index >= 0; index -= 1) {
    const ranges = sectionRanges(text, previous[index]!);
    const last = ranges.at(-1);
    if (!last) continue;
    const before = text.slice(0, last.end).trimEnd();
    const after = text.slice(last.end).trimStart();
    return [before, section, after].filter(Boolean).join("\n\n");
  }
  return [section, text.trim()].filter(Boolean).join("\n\n");
}

interface MemorySection {
  readonly heading: string;
  readonly body: string;
}

const FENCE = /^(```|~~~)/;
const EMPTY_ISSUES = /^(none|n\/a|no (known |genuine |open )?(issues|risks)( or risks)?)\.?$/i;

function splitSections(text: string): { preamble: string; sections: MemorySection[] } {
  const preamble: string[] = [];
  const sections: { heading: string; body: string[] }[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (FENCE.test(trimmed)) fenced = !fenced;
    if (!fenced && /^##\s/.test(trimmed)) sections.push({ heading: trimmed, body: [] });
    else if (sections.length > 0) sections.at(-1)!.body.push(line);
    else preamble.push(line);
  }
  return {
    preamble: preamble.join("\n").trim(),
    sections: sections.map(({ heading, body }) => ({ heading, body: body.join("\n").trim() })),
  };
}

function headingRank(heading: string): number {
  const index = MODEL_MEMORY_HEADINGS.findIndex((known) => normalizedHeading(known) === normalizedHeading(heading));
  return index < 0 ? MODEL_MEMORY_HEADINGS.length : index;
}

function isDiscarded(section: MemorySection): boolean {
  const heading = normalizedHeading(section.heading);
  if (heading === normalizedHeading(RECENT_PROMPTS_HEADING)) return true;
  return heading === normalizedHeading(ISSUES_HEADING) && (section.body === "" || EMPTY_ISSUES.test(section.body.replace(/^[-*]\s*/, "")));
}

export function canonicalMemoryLayout(text: string): string {
  const { preamble, sections } = splitSections(text);
  const merged = new Map<string, MemorySection>();
  for (const section of sections) {
    const rank = headingRank(section.heading);
    const known = rank < MODEL_MEMORY_HEADINGS.length;
    const key = known ? normalizedHeading(section.heading) : `${normalizedHeading(section.heading)}#${merged.size}`;
    const existing = merged.get(key);
    merged.set(key, {
      heading: known ? MODEL_MEMORY_HEADINGS[rank]! : section.heading,
      body: [existing?.body, section.body].filter(Boolean).join("\n"),
    });
  }
  const ordered = [...merged.values()]
    .filter((section) => !isDiscarded(section))
    .map((section, index) => ({ section, index }))
    .sort((a, b) => headingRank(a.section.heading) - headingRank(b.section.heading) || a.index - b.index)
    .map(({ section }) => (section.body ? `${section.heading}\n${section.body}` : section.heading));
  return [preamble, ...ordered].filter(Boolean).join("\n\n");
}
