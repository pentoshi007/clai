
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { pathToFileURL } from "node:url";
import {
  detectModelImageMediaType,
  imageBudgetFor,
  type ImageBudget,
} from "../attachments/image-content.js";
import { prepareImageForModel } from "../attachments/image-prepare.js";
import { safeCwd } from "../os/cwd.js";
import type { ChatImage } from "../types.js";
import { expandHome } from "./mentions/file-suggestions.js";
import { classifyPath, extractMentionTokens, normalizeDroppedPath, stabilizeImagePaths, tokenToPath } from "./mentions/expand.js";
export { expandMentions } from "./mentions/expand.js";
export { extractMentionTokens, normalizeDroppedPath, stabilizeImagePaths };
export type { Attachment, AttachmentKind, ExpandMentionsOptions, MentionExpansion } from "./mentions/expand.js";
export { findFileSuggestions } from "./mentions/file-suggestions.js";
export type { FileSuggestion } from "./mentions/file-suggestions.js";


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

export function getMentionQuery(
  line: string,
  cursor: number,
): { query: string; start: number } | null {
  const upto = line.slice(0, cursor);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(line[at - 1] ?? "")) return null;
  const token = upto.slice(at + 1);
  if (/\s/.test(token)) return null;
  return { query: token, start: at };
}

function resolveExistingFile(abs: string): string | undefined {
  try {
    if (existsSync(abs) && statSync(abs).isFile()) return abs;
  } catch {
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
      }
    }
  }
  return undefined;
}

function canonicalizeName(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[\u00a0\u2007\u202f\u2009\u200a\u2002\u2003\u3000]/g, " ");
}

interface ScannedPath {
  raw: string;
  resolved: string;
}

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
        break;
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
