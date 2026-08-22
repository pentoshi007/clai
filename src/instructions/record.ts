import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  PROJECT_DIR_NAME,
  RECORDED_INSTRUCTIONS_FILE,
  recordedInstructionsPath,
  scaffoldTargetDir,
} from "./locations.js";
import { invalidateInstructionCache } from "./load.js";

const ACTIVE_HEADING = "## Active";
const MAX_ENTRIES = 40;
const MAX_ENTRY_CHARS = 300;

export const RECORDED_INSTRUCTIONS_TEMPLATE = `# INSTRUCTIONS.md

<!--
Maintained by clai. Standing instructions clai captured from you during sessions
in this project, kept here so they survive context compaction. Edit or delete any
line freely; write your own long-lived rules in CLAI.md instead.
-->

${ACTIVE_HEADING}

`;

export interface RecordInstructionsInput {
  readonly cwd: string;
  readonly projectRoot?: string | undefined;
  readonly add?: readonly string[] | undefined;
  readonly remove?: readonly string[] | undefined;
}

export interface RecordInstructionsResult {
  readonly path: string;
  readonly active: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly dropped: number;
}

export function normalizeInstructionEntry(raw: string): string | undefined {
  const cleaned = raw
    .replace(/\r?\n+/g, " ")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 3) return undefined;
  return cleaned.length > MAX_ENTRY_CHARS
    ? `${cleaned.slice(0, MAX_ENTRY_CHARS - 1).trimEnd()}…`
    : cleaned;
}

export function parseRecordedInstructions(text: string): {
  readonly preamble: string;
  readonly active: string[];
  readonly trailing: string;
} {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const headingIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === ACTIVE_HEADING.toLowerCase(),
  );
  if (headingIndex < 0) {
    const bullets: string[] = [];
    const kept: string[] = [];
    for (const line of lines) {
      const bullet = /^\s*[-*+]\s+(.*\S)\s*$/.exec(line);
      if (bullet) {
        const entry = normalizeInstructionEntry(bullet[1]!);
        if (entry) bullets.push(entry);
        continue;
      }
      kept.push(line);
    }
    return { preamble: kept.join("\n").trimEnd(), active: bullets, trailing: "" };
  }
  const preamble = lines.slice(0, headingIndex).join("\n").trimEnd();
  const active: string[] = [];
  const trailing: string[] = [];
  let inSection = true;
  for (const line of lines.slice(headingIndex + 1)) {
    if (inSection && /^#{1,6}\s/.test(line.trim())) inSection = false;
    if (!inSection) {
      trailing.push(line);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*\S)\s*$/.exec(line);
    if (!bullet) continue;
    const entry = normalizeInstructionEntry(bullet[1]!);
    if (entry) active.push(entry);
  }
  return { preamble, active, trailing: trailing.join("\n").trimEnd() };
}

function renderRecordedInstructions(input: {
  readonly preamble: string;
  readonly active: readonly string[];
  readonly trailing: string;
}): string {
  const preamble = input.preamble.trim().length > 0
    ? input.preamble.trimEnd()
    : RECORDED_INSTRUCTIONS_TEMPLATE.split(ACTIVE_HEADING)[0]!.trimEnd();
  const body = input.active.map((entry) => `- ${entry}`).join("\n");
  return [
    preamble,
    "",
    ACTIVE_HEADING,
    "",
    body,
    input.trailing.trim().length > 0 ? `\n${input.trailing.trimEnd()}` : "",
    "",
  ].join("\n");
}

async function readExisting(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return RECORDED_INSTRUCTIONS_TEMPLATE;
  }
}

function matchesRemoval(entry: string, target: string): boolean {
  const a = entry.toLowerCase().replace(/[.!]+$/, "");
  const b = target.toLowerCase().replace(/[.!]+$/, "");
  return a === b || a.includes(b) || b.includes(a);
}

export async function recordInstructions(
  input: RecordInstructionsInput,
): Promise<RecordInstructionsResult | undefined> {
  const root = scaffoldTargetDir({
    cwd: input.cwd,
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
  });
  if (!root) return undefined;
  const path = recordedInstructionsPath(root);
  const parsed = parseRecordedInstructions(await readExisting(path));
  const active = [...parsed.active];
  const added: string[] = [];
  const removed: string[] = [];

  for (const raw of input.remove ?? []) {
    const trimmed = raw.trim();
    let index = -1;
    if (/^\d+$/.test(trimmed)) {
      index = Number(trimmed) - 1;
    } else {
      const target = normalizeInstructionEntry(trimmed);
      if (!target) continue;
      index = active.findIndex((entry) => matchesRemoval(entry, target));
    }
    if (index < 0 || index >= active.length) continue;
    removed.push(active[index]!);
    active.splice(index, 1);
  }

  for (const raw of input.add ?? []) {
    const entry = normalizeInstructionEntry(raw);
    if (!entry) continue;
    const duplicate = active.some(
      (existing) => existing.toLowerCase() === entry.toLowerCase(),
    );
    if (duplicate) continue;
    active.push(entry);
    added.push(entry);
  }

  let dropped = 0;
  if (active.length > MAX_ENTRIES) {
    dropped = active.length - MAX_ENTRIES;
    active.splice(0, dropped);
  }

  const contents = renderRecordedInstructions({
    preamble: parsed.preamble,
    active,
    trailing: parsed.trailing,
  });
  await mkdir(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${RECORDED_INSTRUCTIONS_FILE}.${process.pid}.tmp`);
  await writeFile(temp, contents, "utf8");
  await rename(temp, path);
  invalidateInstructionCache(path);
  return { path, active, added, removed, dropped };
}

export function recordedInstructionsDirName(): string {
  return PROJECT_DIR_NAME;
}
