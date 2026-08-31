import { safeCwd } from "../../os/cwd.js";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

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

export interface FileSuggestion {
  /** The text to insert after the leading "@" (e.g. "src/App.tsx" or "src/"). */
  value: string;
  /** Display label. */
  label: string;
  isDir: boolean;
}

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\"))
    return join(homedir(), p.slice(2));
  return p;
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
