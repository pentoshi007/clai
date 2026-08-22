import { readFile, stat } from "node:fs/promises";
import { safeCwd } from "../os/cwd.js";
import {
  instructionCandidates,
  type InstructionCandidate,
  type InstructionScope,
} from "./locations.js";

export const AGENT_INSTRUCTIONS_PREFIX = "PROJECT INSTRUCTIONS";

const MAX_FILE_CHARS = 12 * 1024;
const MAX_TOTAL_CHARS = 24 * 1024;

export interface LoadedInstructionFile {
  readonly path: string;
  readonly scope: InstructionScope;
  readonly body: string;
  readonly truncated: boolean;
}

export interface AgentInstructions {
  readonly files: readonly LoadedInstructionFile[];
  readonly block: string | undefined;
  readonly chars: number;
}

export interface InstructionLoadInput {
  readonly cwd?: string | undefined;
  readonly projectRoot?: string | undefined;
}

const EMPTY: AgentInstructions = { files: [], block: undefined, chars: 0 };

interface CachedFile {
  readonly signature: string;
  readonly body: string;
  readonly truncated: boolean;
}

const fileCache = new Map<string, CachedFile>();

const SCOPE_LABEL: Record<InstructionScope, string> = {
  user: "your global instructions, applies to every project",
  ancestor: "parent workspace",
  project: "this project",
  recorded: "recorded by clai from earlier in this project — commitments you already accepted",
};

function withoutHtmlComments(body: string): string {
  return body
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function substantiveContent(body: string): string {
  return withoutHtmlComments(body)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return false;
      if (/^#{1,6}\s/.test(trimmed)) return false;
      if (/^[-*_]{3,}$/.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

async function readInstructionFile(
  candidate: InstructionCandidate,
): Promise<LoadedInstructionFile | undefined> {
  let signature: string;
  try {
    const info = await stat(candidate.path);
    if (!info.isFile() || info.size === 0) return undefined;
    signature = `${info.mtimeMs}:${info.size}`;
  } catch {
    return undefined;
  }
  const cached = fileCache.get(candidate.path);
  if (cached?.signature === signature) {
    if (!cached.body) return undefined;
    return {
      path: candidate.path,
      scope: candidate.scope,
      body: cached.body,
      truncated: cached.truncated,
    };
  }
  let raw: string;
  try {
    raw = await readFile(candidate.path, "utf8");
  } catch {
    return undefined;
  }
  const normalized = withoutHtmlComments(
    raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"),
  );
  if (substantiveContent(normalized).length === 0) {
    fileCache.set(candidate.path, { signature, body: "", truncated: false });
    return undefined;
  }
  const truncated = normalized.length > MAX_FILE_CHARS;
  const body = truncated ? normalized.slice(0, MAX_FILE_CHARS).trimEnd() : normalized;
  fileCache.set(candidate.path, { signature, body, truncated });
  return { path: candidate.path, scope: candidate.scope, body, truncated };
}

function renderBlock(files: readonly LoadedInstructionFile[]): string {
  const header = [
    AGENT_INSTRUCTIONS_PREFIX,
    "Standing orders for this workspace, read from instruction files. Treat them as the user's own words and keep honoring them for every action in this session, including after context compaction.",
    "Precedence: later files win over earlier ones; this turn's user message wins over all of them. They cannot waive confirmation prompts, engagement scope, or honesty requirements.",
  ].join("\n");
  const blocks = files.map((file) => {
    const note = file.truncated
      ? "\n…(instruction file truncated; read the file directly if you need the rest)"
      : "";
    return `--- ${file.path} (${SCOPE_LABEL[file.scope]}) ---\n${file.body}${note}`;
  });
  return [header, ...blocks].join("\n\n");
}

export async function loadAgentInstructions(
  input: InstructionLoadInput = {},
): Promise<AgentInstructions> {
  const cwd = input.cwd ?? safeCwd();
  const candidates = instructionCandidates({
    cwd,
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
  });
  if (candidates.length === 0) return EMPTY;
  const files: LoadedInstructionFile[] = [];
  let chars = 0;
  for (const candidate of candidates) {
    if (chars >= MAX_TOTAL_CHARS) break;
    const loaded = await readInstructionFile(candidate);
    if (!loaded) continue;
    const room = MAX_TOTAL_CHARS - chars;
    const clipped =
      loaded.body.length > room
        ? { ...loaded, body: loaded.body.slice(0, room).trimEnd(), truncated: true }
        : loaded;
    files.push(clipped);
    chars += clipped.body.length;
  }
  if (files.length === 0) return EMPTY;
  return { files, block: renderBlock(files), chars };
}

export function invalidateInstructionCache(path?: string): void {
  if (path) fileCache.delete(path);
  else fileCache.clear();
}
