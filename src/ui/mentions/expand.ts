import { imageBudgetFor } from "../../attachments/image-content.js";
import type { ImageBudget } from "../../attachments/image-content.js";
import { prepareImageForModel } from "../../attachments/image-prepare.js";
import { safeCwd } from "../../os/cwd.js";
import { scratchDirFor } from "../../prompts/index.js";
import { expandHome } from "./file-suggestions.js";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  raw: string;
  path: string;
  kind: AttachmentKind;
  content?: string;
  truncated?: boolean;
  note?: string;
  sendable?: boolean;
}

export interface MentionExpansion {
  text: string;
  attachments: Attachment[];
  contextBlock: string;
}

export interface ExpandMentionsOptions {
  visionCapable?: boolean | undefined;
  budget?: ImageBudget | undefined;
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

export function classifyPath(absPath: string): AttachmentKind {
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

export function tokenToPath(token: string, baseDir: string): string {
  let path = token;
  if (path.startsWith("@")) path = path.slice(1);
  path = normalizeDroppedPath(path);
  path = path.replace(/[\\/]+$/, "") || path;
  path = expandHome(path);
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

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
