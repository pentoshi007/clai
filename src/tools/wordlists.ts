/**
 * Locate wordlist files for fuzzing tools. Searches known paths first, then
 * broadens to locate DB, full filesystem, and sudo-elevated search so
 * wordlists are found regardless of install location or OS.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ToolResult } from "../types.js";

const IS_WIN = platform() === "win32";
const IS_MAC = platform() === "darwin";
const HOME = homedir();

// --- Known roots per OS ---

function knownRoots(): string[] {
  const common = [
    join(HOME, "wordlists"),
    join(HOME, "SecLists"),
    join(HOME, "seclists"),
    join(HOME, ".wordlists"),
    join(HOME, "Documents", "wordlists"),
    join(HOME, "Documents", "SecLists"),
    join(HOME, "projects"),
    join(HOME, "github"),
    join(HOME, "repos"),
    join(HOME, "pentesting"),
    join(HOME, "pentest"),
  ];
  if (IS_WIN) {
    return [
      ...common,
      "C:\\SecLists",
      "C:\\Tools\\SecLists",
      "C:\\Tools\\wordlists",
      join(HOME, "Tools", "SecLists"),
    ];
  }
  if (IS_MAC) {
    return [
      ...common,
      "/opt/homebrew/share/seclists",
      "/opt/homebrew/share/wordlists",
      "/usr/local/share/seclists",
      "/usr/local/share/wordlists",
      "/opt/local/share/seclists",
      "/opt/local/share/wordlists",
      "/usr/share/wordlists",
      "/usr/share/seclists",
    ];
  }
  return [
    ...common,
    "/usr/share/wordlists",
    "/usr/share/seclists",
    "/usr/share/dirb/wordlists",
    "/usr/share/dirbuster/wordlists",
    "/usr/share/wfuzz/wordlist",
    "/opt/SecLists",
    "/opt/wordlists",
    "/var/wordlists",
    "/pentest",
  ];
}

// --- Aliases ---

const NAME_ALIASES: Record<string, string[]> = {
  common: ["common.txt", "common.txt.gz"],
  "common.txt": ["common.txt"],
  big: ["big.txt"],
  medium: ["directory-list-2.3-medium.txt"],
  small: ["directory-list-2.3-small.txt"],
  rockyou: ["rockyou.txt", "rockyou.txt.gz"],
  subdomains: ["subdomains-top1million-5000.txt", "subdomains-top1million-20000.txt"],
  "raft-small": ["raft-small-words.txt", "raft-small-directories.txt"],
  "raft-medium": ["raft-medium-words.txt", "raft-medium-directories.txt"],
};

function candidateFilenames(query: string): string[] {
  const lower = query.toLowerCase().trim();
  return NAME_ALIASES[lower] ?? [query];
}

// --- Search helpers ---

function parseLines(raw: string): string[] {
  return raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function buildFindNameExpr(filenames: string[]): string[] {
  return filenames.flatMap((f, i) => (i === 0 ? ["-name", f] : ["-o", "-name", f]));
}

// Quiet directory search: capped depth, timeout, stderr suppressed.
function searchRoot(root: string, filenames: string[], maxDepth: number): string[] {
  if (!existsSync(root)) return [];
  try {
    if (IS_WIN) {
      const namePattern = filenames.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
      const script =
        `Get-ChildItem -Path '${root.replace(/'/g, "''")}' -Recurse -File ` +
        `-Depth ${maxDepth} -ErrorAction SilentlyContinue ` +
        `| Where-Object { @(${namePattern}) -contains $_.Name } ` +
        `| Select-Object -First 20 -ExpandProperty FullName`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        timeout: 8_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      return parseLines(out);
    }
    const nameExpr = buildFindNameExpr(filenames);
    const out = execFileSync(
      "find", [root, "-maxdepth", String(maxDepth), "-type", "f", "(", ...nameExpr, ")"],
      { timeout: 8_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseLines(out);
  } catch {
    return [];
  }
}

// Query the locate/mlocate DB — fast, no root needed. POSIX only.
function searchLocate(filenames: string[]): string[] {
  if (IS_WIN) return [];
  const hits: string[] = [];
  for (const f of filenames) {
    try {
      const out = execFileSync("locate", ["-i", "-l", "20", f], {
        timeout: 5_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      hits.push(...parseLines(out));
    } catch {
      // locate not installed or DB not built — skip silently.
    }
    if (hits.length > 0) break;
  }
  return hits;
}

// Full filesystem search. POSIX: find /, Windows: all drive letters.
function searchFullFilesystem(filenames: string[]): string[] {
  try {
    if (IS_WIN) {
      const namePattern = filenames.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
      // Discover available drive letters
      const drivesRaw = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", "(Get-PSDrive -PSProvider FileSystem).Root -join ','"],
        { timeout: 3_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      const drives = parseLines(drivesRaw.replace(/,/g, "\n"));
      if (drives.length === 0) return [];
      const paths = drives.map((d) => `'${d.replace(/'/g, "''")}'`).join(",");
      const script =
        `Get-ChildItem -Path ${paths} -Recurse -File ` +
        `-Depth 6 -ErrorAction SilentlyContinue ` +
        `| Where-Object { @(${namePattern}) -contains $_.Name } ` +
        `| Select-Object -First 20 -ExpandProperty FullName`;
      const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
        timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
      });
      return parseLines(out);
    }
    const nameExpr = buildFindNameExpr(filenames);
    const out = execFileSync(
      "find", ["/", "-maxdepth", "8", "-type", "f", "(", ...nameExpr, ")"],
      { timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseLines(out);
  } catch {
    return [];
  }
}

// Sudo-elevated find /. Tries non-interactive first (cached creds), then
// interactive (prompts for password via terminal). POSIX only.
function searchSudo(filenames: string[]): string[] {
  if (IS_WIN) return [];
  const nameExpr = buildFindNameExpr(filenames);
  const findArgs = ["/", "-maxdepth", "8", "-type", "f", "(", ...nameExpr, ")"];
  // Try non-interactive sudo first (succeeds if creds are cached).
  try {
    const out = execFileSync("sudo", ["-n", "find", ...findArgs], {
      timeout: 15_000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    });
    const hits = parseLines(out);
    if (hits.length > 0) return hits;
  } catch { /* creds not cached — fall through to interactive */ }
  // Interactive sudo: inherit stdin so the terminal can prompt for password.
  try {
    const out = execFileSync("sudo", ["find", ...findArgs], {
      timeout: 30_000, encoding: "utf8", stdio: ["inherit", "pipe", "ignore"],
    });
    return parseLines(out);
  } catch {
    return [];
  }
}


// --- Result builder ---

function found(hits: string[], source: string): ToolResult {
  return { ok: true, output: `${source}:\n${hits.join("\n")}`, exitCode: 0 };
}

// --- Main ---

export interface WordlistFindArgs {
  query: string;
  expand?: boolean | undefined;
}

export async function wordlistFind(args: WordlistFindArgs): Promise<ToolResult> {
  const query = args.query?.trim();
  if (!query) {
    return { ok: false, output: "wordlist.find requires a query, e.g. \"common.txt\" or \"rockyou\".", exitCode: 1 };
  }
  const filenames = candidateFilenames(query);
  const roots = knownRoots();

  // Pass 1: well-known install locations (shallow, fast).
  for (const root of roots) {
    const hits = searchRoot(root, filenames, 6);
    if (hits.length > 0) return found(hits, "Found in a known wordlist location");
  }

  if (args.expand === false) {
    return {
      ok: false,
      output:
        `No match for "${query}" in known wordlist locations for ${platform()}.\n` +
        `Checked: ${roots.join(", ")}\n` +
        `Retry with expand=true to broaden the search, or pkg.install seclists.`,
      exitCode: 1,
    };
  }

  // Pass 2: broader user directories.
  const broaderRoots = [
    join(HOME, "Downloads"), join(HOME, "Desktop"),
    join(HOME, "Documents"), join(HOME, "Projects"),
    join(HOME, "tools"), join(HOME, "Tools"),
    join(HOME, "github"), join(HOME, "repos"),
    join(HOME, "pentesting"), join(HOME, "pentest"),
    "/opt",
  ].filter((r) => !roots.includes(r));

  for (const root of broaderRoots) {
    const hits = searchRoot(root, filenames, 4);
    if (hits.length > 0) return found(hits, "Found in user directory");
  }

  // Pass 3: locate database (fast indexed search, POSIX only).
  const locateHits = searchLocate(filenames);
  if (locateHits.length > 0) return found(locateHits, "Found via locate database");

  // Pass 4: full filesystem search (find / or all Windows drives).
  const fsHits = searchFullFilesystem(filenames);
  if (fsHits.length > 0) return found(fsHits, "Found via full filesystem search");

  // Pass 5: sudo-elevated search (POSIX only, non-interactive).
  const sudoHits = searchSudo(filenames);
  if (sudoHits.length > 0) return found(sudoHits, "Found via elevated filesystem search");

  return {
    ok: false,
    output:
      `No wordlist matching "${query}" found after searching the entire filesystem.\n` +
      `Install one: pkg.install seclists (Linux/macOS) or clone https://github.com/danielmiessler/SecLists.\n` +
      `If running without root, try: sudo clai`,
    exitCode: 1,
  };
}
