import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  detectModelImageMediaType,
  imageBudgetFor,
  type ImageBudget,
} from "../attachments/image-content.js";
import { prepareImageForModel } from "../attachments/image-prepare.js";
import { safeCwd } from "../os/cwd.js";
import type { ChatImage } from "../types.js";
import { scratchDirFor } from "../prompts/index.js";

/**
 * @-mention + drag-and-drop file support for the REPL prompt.
 *
 * Two jobs:
 *  1. Autocomplete: while the user types `@partial/path`, suggest matching
 *     files/dirs from the working directory (like Claude Code / opencode).
 *  2. Expansion: when a prompt is submitted, turn `@path` mentions and any
 *     drag-and-dropped file paths into real context — inlining text files
 *     and noting binary files (images/pdfs) by path so the agent can act on
 *     them with its tools.
 *
 * All filesystem access here is best-effort and synchronous for the
 * autocomplete path so it can run inside the keypress handler; expansion
 * is async-friendly but kept sync-read for simplicity (local files only).
 */

// Directories we never want to surface in autocomplete or recurse into —
// they're huge and almost never what the user means to attach.
const NOISE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  "out",
  ".next",
  ".cache",
  ".turbo",
  "coverage",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".DS_Store",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".rst",
  ".log",
  ".csv",
  ".tsv",
  ".json",
  ".jsonc",
  ".json5",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".env.example",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".scala",
  ".clj",
  ".ex",
  ".exs",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".bat",
  ".cmd",
  ".html",
  ".htm",
  ".xml",
  ".svg",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".vue",
  ".svelte",
  ".astro",
  ".sql",
  ".graphql",
  ".gql",
  ".proto",
  ".conf",
  ".cfg",
  ".properties",
  ".gradle",
  ".dockerfile",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
  ".tif",
  ".ico",
  ".heic",
]);

const DOC_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
]);

export type AttachmentKind =
  | "text"
  | "image"
  | "document"
  | "binary"
  | "directory"
  | "missing";

export interface Attachment {
  /** Raw token as it appeared in the prompt (e.g. "@src/App.tsx"). */
  raw: string;
  /** Absolute resolved path. */
  path: string;
  kind: AttachmentKind;
  /** Inlined text contents (text kind only). */
  content?: string;
  truncated?: boolean;
  /** Human-readable note (binary/missing/directory). */
  note?: string;
  /**
   * Image kind only: the bytes decode to a model-supported image within the
   * size cap. Callers must not switch models for a rejected image.
   */
  sendable?: boolean;
}

export interface FileSuggestion {
  /** The text to insert after the leading "@" (e.g. "src/App.tsx" or "src/"). */
  value: string;
  /** Display label. */
  label: string;
  isDir: boolean;
}

export interface MentionExpansion {
  /** The original prompt text, unchanged (mentions stay readable in history). */
  text: string;
  attachments: Attachment[];
  /** Context block to append to the model message, or "" if no attachments. */
  contextBlock: string;
}

export interface ExpandMentionsOptions {
  visionCapable?: boolean | undefined;
  budget?: ImageBudget | undefined;
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
};

export function imageMediaType(absPath: string): string | undefined {
  return IMAGE_MEDIA_TYPES[extname(absPath).toLowerCase()];
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\"))
    return join(homedir(), p.slice(2));
  return p;
}

export function normalizeDroppedPath(token: string): string {
  let normalized = token.trim();
  if (normalized.length === 0) return normalized;
  if (
    (normalized.startsWith("'") &&
      normalized.endsWith("'") &&
      normalized.length >= 2) ||
    (normalized.startsWith('"') &&
      normalized.endsWith('"') &&
      normalized.length >= 2)
  ) {
    normalized = normalized.slice(1, -1);
  } else if (normalized.endsWith("'") || normalized.endsWith('"')) {
    normalized = normalized.slice(0, -1);
  }
  if (/^file:\/\//i.test(normalized)) {
    try {
      return fileURLToPath(normalized);
    } catch {
      return normalized;
    }
  }
  const windowsPath =
    /^[A-Za-z]:[\\/]/.test(normalized) || /^\\\\/.test(normalized);
  if (!windowsPath) normalized = normalized.replace(/\\(.)/g, "$1");
  return normalized;
}

export function formatAttachmentReference(
  path: string,
  baseDir: string = safeCwd(),
): string {
  const normalized = expandHome(normalizeDroppedPath(path));
  const absolute = isAbsolute(normalized)
    ? normalized
    : resolve(baseDir, normalized);
  return pathToFileURL(absolute).href;
}

/**
 * Given the current input line and cursor index, return the partial @-mention
 * the user is typing, or null if the cursor is not inside one.
 *
 * A mention token starts with "@" that is at line start or preceded by
 * whitespace, and runs (without whitespace) up to the cursor.
 */
export function getMentionQuery(
  line: string,
  cursor: number,
): { query: string; start: number } | null {
  const upto = line.slice(0, cursor);
  // Find the last "@" before the cursor.
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  // Must be at start or preceded by whitespace.
  if (at > 0 && !/\s/.test(line[at - 1] ?? "")) return null;
  const token = upto.slice(at + 1);
  // No whitespace inside an in-progress mention (we autocomplete a single path).
  if (/\s/.test(token)) return null;
  return { query: token, start: at };
}

/**
 * Synchronously list file/dir suggestions for an in-progress @-mention.
 * `query` is the text after "@" (may include a directory portion like
 * "src/comp"). Suggestions are returned relative to `baseDir` unless the
 * query is absolute or home-anchored.
 */
export function findFileSuggestions(
  query: string,
  baseDir: string = safeCwd(),
  limit = 12,
): FileSuggestion[] {
  const anchored = query.startsWith("/") || query.startsWith("~");
  const expanded = expandHome(query);

  // Split into "directory part" + "name prefix".
  let dirPart: string;
  let prefix: string;
  if (query.endsWith("/")) {
    dirPart = expanded;
    prefix = "";
  } else {
    dirPart = dirname(expanded);
    prefix = basename(expanded);
    // dirname(".") or dirname("foo") => "." — keep relative root.
    if (dirPart === "." && !expanded.includes("/")) dirPart = "";
  }

  const searchDir = anchored
    ? dirPart === ""
      ? "/"
      : dirPart
    : resolve(baseDir, dirPart);

  let entries: string[];
  try {
    entries = readdirSync(searchDir);
  } catch {
    return [];
  }

  const lowerPrefix = prefix.toLowerCase();
  const matched: FileSuggestion[] = [];

  // When browsing inside a path (`@src/` or `@src/comp`), offer `../` so the
  // user can walk back up without backspacing the whole token.
  if (dirPart !== "" && (prefix === "" || "..".startsWith(lowerPrefix))) {
    const parentRaw = dirPart.replace(/\/+$/, "");
    const parentDir = dirname(parentRaw);
    const parentValue =
      parentDir === "." || parentDir === ""
        ? ""
        : parentDir.endsWith("/")
          ? parentDir
          : `${parentDir}/`;
    matched.push({
      value: parentValue,
      label: "../",
      isDir: true,
    });
  }

  for (const name of entries) {
    if (prefix === "" && NOISE_DIRS.has(name)) continue;
    if (prefix === "" && name.startsWith(".")) continue; // hide dotfiles unless typed
    if (!name.toLowerCase().startsWith(lowerPrefix)) continue;

    let isDir = false;
    try {
      isDir = statSync(join(searchDir, name)).isDirectory();
    } catch {
      continue;
    }

    // Reconstruct the value to insert after "@" (preserve the dir portion the
    // user already typed).
    const joined =
      dirPart === "" ? name : `${dirPart.replace(/\/$/, "")}/${name}`;
    const value = isDir ? `${joined}/` : joined;
    matched.push({
      value,
      label: isDir ? `${name}/` : name,
      isDir,
    });
  }

  matched.sort((a, b) => {
    // Keep "../" first when present, then other dirs, then files.
    if (a.label === "../") return -1;
    if (b.label === "../") return 1;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return matched.slice(0, limit);
}

function classifyPath(absPath: string): AttachmentKind {
  if (!existsSync(absPath)) return "missing";
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(absPath);
  } catch {
    return "missing";
  }
  if (st.isDirectory()) return "directory";
  if (!st.isFile()) return "binary";
  const ext = extname(absPath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (DOC_EXTENSIONS.has(ext)) return "document";
  if (TEXT_EXTENSIONS.has(ext) || ext === "") return "text";
  return "binary";
}

/**
 * Extract candidate file tokens from a submitted line:
 *  - explicit "@path" mentions (preceded by start/whitespace), and
 *  - explicit file:// references created for dropped files.
 *
 * Returns the raw token strings (including any leading "@") in order.
 */
export function extractMentionTokens(line: string): string[] {
  const tokens: string[] = [];
  const mentionRe = /(^|\s)@(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRe.exec(line)) !== null) {
    const token = `@${match[2]}`;
    if (/^@mcp:/i.test(token)) continue;
    tokens.push(token);
  }

  const referenceRe = /file:\/\/[^\s)\]}>]+/gi;
  while ((match = referenceRe.exec(line)) !== null) {
    if (match[0]) tokens.push(match[0]);
  }

  return [...new Set(tokens)];
}

/**
 * Resolve an absolute path tolerantly. Returns the on-disk path when it
 * exists exactly, OR — when it doesn't — scans the parent directory for a
 * single file whose name matches after normalizing Unicode whitespace and
 * NFC/NFD form. This is essential on macOS, where screenshot filenames use
 * a NARROW NO-BREAK SPACE (U+202F) before "AM/PM" and NFD normalization,
 * so a path typed/dragged with a regular space fails existsSync outright.
 */
function resolveExistingFile(abs: string): string | undefined {
  try {
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  } catch {
    /* fall through to fuzzy match */
  }
  const dir = dirname(abs);
  const wantedRaw = basename(abs);
  const wanted = canonicalizeName(wantedRaw);
  if (!wanted) return undefined;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return undefined;
  }
  for (const name of entries) {
    if (canonicalizeName(name) === wanted) {
      const candidate = join(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/** Normalize a filename for tolerant comparison: collapse all Unicode space
 *  variants (NBSP, narrow NBSP, thin space, etc.) to a regular space and
 *  unify Unicode normalization form. */
function canonicalizeName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[\u00a0\u2007\u202f\u2009\u200a\u2002\u2003\u3000]/g, " ");
}

interface ScannedPath {
  /** Exact substring of the input line (for in-place rewrite). */
  raw: string;
  /** Absolute on-disk path the substring resolved to. */
  resolved: string;
}

/** End offsets (exclusive) of each whitespace-delimited word in `rest`,
 *  treating a backslash-escaped space ("\ ") as part of the word so
 *  drag-dropped paths with escaped spaces stay intact. */
function wordEndOffsets(rest: string): number[] {
  const ends: number[] = [];
  let i = 0;
  const n = rest.length;
  while (i < n) {
    while (i < n && /\s/.test(rest[i] ?? "")) i += 1;
    if (i >= n) break;
    while (i < n) {
      if (rest[i] === "\\" && rest[i + 1] === " ") {
        i += 2;
        continue;
      }
      if (/\s/.test(rest[i] ?? "")) break;
      i += 1;
    }
    ends.push(i);
  }
  return ends;
}

/** Shared core for submit-time path extraction and drop-time stabilization.
 *  For each place a path could start, take the LONGEST word-boundary prefix
 *  that resolves to a real file (tolerant of Unicode whitespace variants) and
 *  return both the raw span and the resolved absolute path. */
function scanExistingPaths(line: string, baseDir: string): ScannedPath[] {
  const results: ScannedPath[] = [];
  const seen = new Set<string>();
  const startRe = /(?:^|\s|["'])((?:file:\/\/|(?:~|\.{1,2})?[\\/]|[A-Za-z]:[\\/]|\\\\))/gi;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(line)) !== null) {
    const startIdx = m.index + m[0].length - (m[1]?.length ?? 0);
    const rest = line.slice(startIdx);
    const ends = wordEndOffsets(rest);
    for (let k = ends.length; k >= 1; k -= 1) {
      const rawSpan = rest.slice(0, ends[k - 1]);
      const candidate = normalizeDroppedPath(rawSpan);
      const expanded = expandHome(candidate);
      const abs = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
      const resolved = resolveExistingFile(abs);
      if (resolved) {
        if (!seen.has(resolved)) {
          seen.add(resolved);
          results.push({ raw: rawSpan, resolved });
        }
        break; // longest match for this start wins
      }
    }
  }
  return results;
}

export function extractExistingPathsFs(
  line: string,
  baseDir: string,
): string[] {
  return scanExistingPaths(line, baseDir).map((match) => match.resolved);
}

/** Non-path residual budget: a paste dominated by prose is not a file drop. */
const MAX_DROP_RESIDUAL = 512;

export function stabilizeDroppedFilesInText(
  text: string,
  baseDir: string = safeCwd(),
): { text: string; files: string[]; images: string[] } {
  const matches = scanExistingPaths(text, baseDir);
  if (matches.length === 0) return { text, files: [], images: [] };
  const matchedChars = matches.reduce((sum, match) => sum + match.raw.length, 0);
  if (text.trim().length - matchedChars > MAX_DROP_RESIDUAL) {
    return { text, files: [], images: [] };
  }
  let rewritten = text;
  const files: string[] = [];
  const images: string[] = [];
  for (const match of matches) {
    const isImage = Boolean(imageMediaType(match.resolved));
    const stable = isImage
      ? stabilizeImagePaths([match.resolved], baseDir)[0] ?? match.resolved
      : match.resolved;
    rewritten = rewritten.replace(match.raw, formatAttachmentReference(stable, baseDir));
    files.push(stable);
    if (isImage) images.push(stable);
  }
  return { text: rewritten, files, images };
}

export function stabilizeDroppedImagesInText(
  text: string,
  baseDir: string = safeCwd(),
): { text: string; images: string[] } {
  const matches = scanExistingPaths(text, baseDir).filter((match) =>
    Boolean(imageMediaType(match.resolved)),
  );
  if (matches.length === 0) return { text, images: [] };
  const matchedChars = matches.reduce((sum, match) => sum + match.raw.length, 0);
  if (text.trim().length - matchedChars > MAX_DROP_RESIDUAL) {
    return { text, images: [] };
  }
  let rewritten = text;
  const images: string[] = [];
  for (const match of matches) {
    const stable = stabilizeImagePaths([match.resolved], baseDir)[0] ?? match.resolved;
    rewritten = rewritten.replace(match.raw, formatAttachmentReference(stable));
    images.push(stable);
  }
  return { text: rewritten, images };
}

function tokenToPath(token: string, baseDir: string): string {
  let path = token;
  if (path.startsWith("@")) path = path.slice(1);
  path = normalizeDroppedPath(path);
  path = path.replace(/[\\/]+$/, "") || path;
  path = expandHome(path);
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

/**
 * Resolve explicit references in a submitted prompt into attachment metadata.
 */
export function expandMentions(
  line: string,
  baseDir: string = safeCwd(),
  vision: boolean | ExpandMentionsOptions = false,
): MentionExpansion {
  const options: ExpandMentionsOptions =
    typeof vision === "boolean" ? { visionCapable: vision } : vision;
  const visionCapable = options.visionCapable === true;
  const budget = options.budget ?? imageBudgetFor("");
  const tokens = extractMentionTokens(line);
  const attachments: Attachment[] = [];
  const seenPaths = new Set<string>();
  for (const token of tokens) {
    const absPath = tokenToPath(token, baseDir);
    if (seenPaths.has(absPath)) continue;
    const kind = classifyPath(absPath);
    seenPaths.add(absPath);

    if (kind === "text") {
      attachments.push({ raw: token, path: absPath, kind: "text" });
    } else if (kind === "image") {
      const stablePath = stabilizeImagePaths([absPath], baseDir)[0] ?? absPath;
      let prepared = prepareImageForModel(stablePath, budget, baseDir);
      if (!prepared.ok && stablePath !== absPath) {
        const original = prepareImageForModel(absPath, budget, baseDir);
        if (original.ok) prepared = original;
      }
      attachments.push({
        raw: token,
        path: prepared.ok ? prepared.path : stablePath,
        kind: "image",
        sendable: prepared.ok,
        note: !prepared.ok
          ? prepared.recoverable
            ? `NOT attached — ${prepared.reason}`
            : `NOT attached — ${prepared.reason}; convert to PNG/JPEG/GIF/WebP first`
          : visionCapable
            ? `attached as multimodal input — inspect it directly; prefer vision over OCR unless OCR is asked for`
            : `not viewable by this model — use image.ocr for text or switch to a vision model for visual detail`,
      });
    } else if (kind === "document") {
      const isPdf = extname(absPath).toLowerCase() === ".pdf";
      attachments.push({
        raw: token,
        path: absPath,
        kind: "document",
        note: isPdf
          ? "PDF file — read it with pdf.read {\"path\":\"<pdf>\"} (extracts the text layer and auto-OCRs scanned PDFs)"
          : "document file — the agent can extract text with shell tools (e.g. textutil/pandoc/libreoffice) if needed",
      });
    } else if (kind === "directory") {
      attachments.push({
        raw: token,
        path: absPath,
        kind: "directory",
        note:
          "not expanded — explore on demand: fs.list {\"path\":\"<dir>\"} to see entries, then fs.read the files you need",
      });
    } else if (kind === "missing") {
      attachments.push({
        raw: token,
        path: absPath,
        kind: "missing",
        note: "path not found",
      });
    } else {
      attachments.push({
        raw: token,
        path: absPath,
        kind: "binary",
        note: "binary or non-text path",
      });
    }
  }

  return {
    text: line,
    attachments,
    contextBlock: "",
  };
}

/**
 * Return the absolute paths of every image attachment referenced in a prompt
 * (via @-mention or drag-drop), regardless of whether the active model
 * supports vision. Used to build an OCR text layer that grounds the model
 * even when a provider silently ignores attached image bytes.
 */
export function imageAttachmentPaths(
  line: string,
  baseDir: string = safeCwd(),
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const candidates = [
    ...extractMentionTokens(line).map((t) => tokenToPath(t, baseDir)),
  ];
  for (const absPath of candidates) {
    if (seen.has(absPath)) continue;
    seen.add(absPath);
    if (classifyPath(absPath) === "image") paths.push(absPath);
  }
  return stabilizeImagePaths(paths, baseDir);
}

export function stabilizeImagePaths(
  paths: string[],
  baseDir: string = safeCwd(),
): string[] {
  const output: string[] = [];
  const attachmentDir = join(scratchDirFor(baseDir), "attachments");
  for (const source of paths) {
    let info;
    try {
      info = statSync(source);
    } catch {
      output.push(source);
      continue;
    }
    if (!info.isFile()) {
      output.push(source);
      continue;
    }
    if (resolve(dirname(source)) === resolve(attachmentDir)) {
      output.push(source);
      continue;
    }
    try {
      mkdirSync(attachmentDir, { recursive: true });
      const extension = extname(source).toLowerCase();
      const stem =
        basename(source, extension)
          .replace(/[^\w.-]+/g, "_")
          .replace(/_+/g, "_")
          .slice(0, 100) || "image";
      const id = createHash("sha1")
        .update(`${resolve(source)}|${Math.round(info.mtimeMs)}|${info.size}`)
        .digest("hex")
        .slice(0, 12);
      const destination = join(
        attachmentDir,
        `${id}-${stem}${extension || ".img"}`,
      );
      if (
        !existsSync(destination) ||
        statSync(destination).size !== info.size
      ) {
        copyFileSync(source, destination);
      }
      output.push(destination);
    } catch {
      output.push(source);
    }
  }
  return output;
}

export function loadImagePaths(
  paths: readonly string[],
  budget: ImageBudget = imageBudgetFor(""),
  baseDir: string = safeCwd(),
): ChatImage[] {
  const images: ChatImage[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (images.length >= budget.maxCount) break;
    const prepared = prepareImageForModel(path, budget, baseDir);
    if (!prepared.ok) continue;
    if (totalBytes + prepared.byteLength > budget.maxTotalBytes) continue;
    try {
      const buffer = readFileSync(prepared.path);
      const mediaType = detectModelImageMediaType(buffer);
      if (!mediaType) continue;
      totalBytes += buffer.length;
      images.push({
        mediaType,
        dataBase64: buffer.toString("base64"),
        path: prepared.path,
      });
    } catch {
      continue;
    }
  }
  return images;
}

export function loadImageAttachments(
  line: string,
  baseDir: string = safeCwd(),
): ChatImage[] {
  return loadImagePaths(
    imageAttachmentPaths(line, baseDir),
    imageBudgetFor(""),
    baseDir,
  );
}
