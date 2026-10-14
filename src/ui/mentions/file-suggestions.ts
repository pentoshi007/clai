import { safeCwd } from "../../os/cwd.js";
import { readdirSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

export interface FileSuggestion {
  value: string;
  label: string;
  isDir: boolean;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\"))
    return join(homedir(), p.slice(2));
  return p;
}

function suggestionIsDirectory(searchDir: string, entry: Dirent): boolean | undefined {
  if (entry.isDirectory()) return true;
  if (entry.isFile() || entry.isBlockDevice() || entry.isCharacterDevice() || entry.isFIFO() || entry.isSocket()) return false;
  try {
    return statSync(join(searchDir, entry.name)).isDirectory();
  } catch {
    return undefined;
  }
}

export function findFileSuggestions(
  query: string,
  baseDir: string = safeCwd(),
  limit = 12,
): FileSuggestion[] {
  const anchored = query.startsWith("/") || query.startsWith("~");
  const expanded = expandHome(query);

  let dirPart: string;
  let prefix: string;
  if (query.endsWith("/")) {
    dirPart = expanded;
    prefix = "";
  } else {
    dirPart = dirname(expanded);
    prefix = basename(expanded);
    if (dirPart === "." && !expanded.includes("/")) dirPart = "";
  }

  const searchDir = anchored
    ? dirPart === ""
      ? "/"
      : dirPart
    : resolve(baseDir, dirPart);

  let entries: Dirent[];
  try {
    entries = readdirSync(searchDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const lowerPrefix = prefix.toLowerCase();
  const matched: FileSuggestion[] = [];

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

  for (const entry of entries) {
    const name = entry.name;
    if (prefix === "" && NOISE_DIRS.has(name)) continue;
    if (prefix === "" && name.startsWith(".")) continue;
    if (!name.toLowerCase().startsWith(lowerPrefix)) continue;

    const isDir = suggestionIsDirectory(searchDir, entry);
    if (isDir === undefined) continue;

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
    if (a.label === "../") return -1;
    if (b.label === "../") return 1;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
  return matched.slice(0, limit);
}
